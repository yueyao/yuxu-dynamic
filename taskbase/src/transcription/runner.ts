/** 串行推进队列；提交使用持久化幂等键，成功结果入库后才确认完成。 */
import { TRANSCRIPTION_APP_ID } from './manifest.ts';
import { TranscriptionQueueStore, type QueueItem } from './queue.ts';
import { TranscriptionStore, type TranscriptSegment } from './store.ts';
import { TranscriptContractError, transcriptVersion, validateTranscript, type DiarizationMetadata } from './contract.ts';

export type PlatformRequest = <T>(path: string, init?: {
  method?: string; body?: unknown; idempotencyKey?: string;
}) => Promise<T>;
type Task = { task_id: string; status: string; progress?: number; error?: string | null; close_reason?: string | null };

export class TranscriptionRunner {
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private ticking = false;
  private readonly queue: TranscriptionQueueStore;
  private readonly transcripts: TranscriptionStore;
  private readonly request: PlatformRequest;
  private readonly episodeId: (id: string) => string;

  constructor(queue: TranscriptionQueueStore,
    transcripts: TranscriptionStore,
    request: PlatformRequest, episodeId: (id: string) => string = (id) => id) {
    this.queue = queue;
    this.transcripts = transcripts;
    this.request = request;
    this.episodeId = episodeId;
    // 补偿旧版本“完成但没有入库”的队列项。
    for (const item of queue.list()) {
      if (item.status === 'done' && item.task_id && !transcripts.getByTask(item.task_id)) {
        queue.markSaving(item.id);
      }
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.exclusive(async () => {
        if (this.stopped) return;
        let item = this.queue.running();
        if (!item) {
          if (this.queue.getState('active') !== '1' || this.queue.getState('paused') === '1') return;
          item = this.queue.next();
          if (!item) return;
          if (!item.force && this.transcripts.getByEpisode(this.episodeId(item.id), 2)) {
            this.queue.markDone(item.id);
            return;
          }
          this.queue.markSubmitting(item.id);
        }
        try {
          if (!item.task_id) {
            await this.submit(item);
            return;
          }
          const task = await this.request<Task>(`/v1/tasks/${encodeURIComponent(item.task_id)}`);
          if (item.error) this.queue.setError(item.id, null);
          this.queue.setState('error', null);
          this.queue.updateProgress(item.id, task.progress ?? 0);
          if (task.status === 'succeeded') {
            this.queue.markSaving(item.id);
            await this.save(item);
          } else if (task.status === 'failed') {
            this.queue.markFailed(item.id, task.error ?? '任务失败');
          } else if (task.status === 'closed') {
            this.queue.markFailed(item.id, task.close_reason ?? '任务已关闭');
          } else if (task.status === 'queued' && item.started_at
            && Date.now() - item.started_at > 10 * 60 * 1000) {
            // 关闭失败时继续保留任务关联，不能制造失去跟踪的任务。
            const closed = await this.request<Task>(`/v1/tasks/${encodeURIComponent(item.task_id)}/close`, {
              method: 'POST', body: { reason: 'worker offline' },
            });
            if (!['closed', 'failed'].includes(closed.status)) return;
            this.queue.markFailed(item.id, 'Worker 10 分钟内未领取，队列已暂停');
            this.queue.setState('paused', '1');
            this.queue.setState('error', 'Worker 未领取任务，请确认 Worker 在线后点击继续');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.queue.setError(item.id, message);
          this.queue.setState('error', message);
          // 未确定提交结果时保留 running + request_key，下轮以相同键查询/提交。
          const status = (error as { status?: number } | null)?.status;
          if (!item.task_id && status && status >= 400 && status < 500 && ![408, 429].includes(status)) {
            this.queue.markFailed(item.id, message);
            this.queue.setState('paused', '1');
          }
        }
      });
    } finally {
      this.ticking = false;
    }
  }

  private async submit(item: QueueItem): Promise<void> {
    // 同一个幂等键必须始终使用同一输入，身份迁移/元数据更新也不能改变在途请求。
    const input = item.submission_json ? JSON.parse(item.submission_json) : {
      audio_url: item.audio_url, episode_id: this.episodeId(item.id), show_id: item.show_id,
      title: item.title, language: 'zh', version: 2,
    };
    this.queue.saveSubmission(item.id, input);
    const created = await this.request<{ task: Task }>('/v1/tasks', {
      method: 'POST', idempotencyKey: `transcription:${item.request_key}`,
      body: { task: `${TRANSCRIPTION_APP_ID}/episode/transcribe`, input },
    });
    this.queue.markRunning(item.id, created.task.task_id);
    this.queue.setState('error', null);
  }

  private async save(item: QueueItem): Promise<void> {
    try { await this.saveResult(item); }
    catch (error) {
      if (error instanceof TranscriptContractError) {
        this.queue.markFailed(item.id, error.message);
        this.queue.setState('paused', '1');
        this.queue.setState('error', error.message);
      }
      throw error;
    }
  }

  private async saveResult(item: QueueItem): Promise<void> {
    if (!item.task_id) throw new Error('缺少平台任务号');
    const expected = item.submission_json ? (JSON.parse(item.submission_json) as { version?: number }).version : undefined;
    const existing = this.transcripts.getByTask(item.task_id);
    if (existing && expected === 2 && existing.version !== 2) {
      throw new TranscriptContractError('TRANSCRIPT_VERSION_CONFLICT: v2任务关联了v1稿件，请检查Worker并重新创建任务');
    }
    if (!existing) {
      const result = await this.request<{ output?: Record<string, unknown> }>(
        `/v1/tasks/${encodeURIComponent(item.task_id)}/result`);
      const output = result.output ?? {};
      const version = transcriptVersion(output.version);
      if (expected === 2 && version !== 2) {
        throw new TranscriptContractError('TRANSCRIPT_VERSION_MISMATCH: v2任务返回v1，请升级Worker后重试');
      }
      validateTranscript({ version, text: output.text, segments: output.segments, diarization: output.diarization });
      if (typeof output.text !== 'string' || !output.text.trim()) {
        throw new Error('平台任务已成功，但转写稿为空；保留任务等待补偿');
      }
      this.transcripts.save({
        version, diarization: version === 2 ? output.diarization as DiarizationMetadata : null,
        taskId: item.task_id, episodeId: this.episodeId(item.id), showId: item.show_id, title: item.title,
        language: typeof output.language === 'string' ? output.language : 'zh',
        provider: typeof output.provider === 'string' ? output.provider : 'unknown',
        model: typeof output.model === 'string' ? output.model : '',
        durationSeconds: typeof output.duration_seconds === 'number' ? output.duration_seconds : null,
        text: output.text, segments: Array.isArray(output.segments) ? output.segments as TranscriptSegment[] : [],
        artifactId: typeof output.artifact_id === 'string' ? output.artifact_id : null,
      });
    }
    this.queue.markDone(item.id);
    this.queue.setState('error', null);
  }

  cancel(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.stopped) throw new Error('队列正在关闭');
      let item = this.queue.get(id);
      if (!item || !['pending', 'running'].includes(item.status)) return false;
      if (item.status === 'running') {
        if (!item.task_id) {
          // 提交响应丢失时先用同一键取得原任务，再关闭。
          await this.submit(item);
          item = this.queue.get(id)!;
        }
        const task = await this.request<Task>(`/v1/tasks/${encodeURIComponent(item.task_id!)}/close`, {
          method: 'POST', body: { reason: '队列取消' },
        });
        if (task.status === 'succeeded') {
          this.queue.markSaving(id);
          await this.save(item);
          return false;
        }
        if (!['closed', 'failed'].includes(task.status)) throw new Error('平台尚未确认任务关闭');
      }
      this.queue.markCanceled(id);
      return true;
    });
  }
}
