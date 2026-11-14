import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/store.ts';
import { transcriptionManifest } from '../src/transcription/manifest.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';
import { TranscriptionRunner, type PlatformRequest } from '../src/transcription/runner.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';

async function harness(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-runner-'));
  const path = join(directory, 'db.sqlite');
  const queue = new TranscriptionQueueStore(path);
  const transcripts = new TranscriptionStore(path);
  const platform = new Store(path);
  platform.upsertApp(transcriptionManifest);
  queue.add([{ episode_id: 'episode', show_id: 'show', title: 'Title', audio_url: 'https://example.com/audio.mp3' }]);
  queue.setState('active', '1');
  queue.setState('paused', '0');
  let loseResponse = false;
  let resultFailure = false;
  let closeFailure = false;
  let status = 'queued';
  let output: Record<string, unknown> = { text: 'Recovered transcript', language: 'zh', version: 2,
    diarization: { provider: 'pyannote', model: 'test' },
    segments: [{ start: 0, end: 1, text: 'Recovered transcript', speaker_id: 'speaker_1' }] };
  let resultReads = 0;
  const request: PlatformRequest = async <T>(path: string, init?: Parameters<PlatformRequest>[1]): Promise<T> => {
    if (path === '/v1/tasks') {
      const body = init!.body as { input: unknown };
      const created = platform.createTask('user:owner', 'transcription-tools', 'episode/transcribe', body.input, init!.idempotencyKey!);
      if (loseResponse) throw new TypeError('response lost after commit');
      return created as T;
    }
    if (path.endsWith('/result')) {
      if (resultFailure) throw new Error('temporary result failure');
      resultReads++;
      return { output } as T;
    }
    if (path.endsWith('/close')) {
      if (closeFailure) throw new Error('close failed');
      return { status: status === 'succeeded' ? 'succeeded' : 'closed' } as T;
    }
    return { status, progress: status === 'succeeded' ? 100 : 0 } as T;
  };
  let runner = new TranscriptionRunner(queue, transcripts, request);
  t.after(async () => {
    await runner.stop(); queue.close(); transcripts.close(); platform.closeDb();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    queue, transcripts, platform, get runner() { return runner; },
    responseLost(value: boolean) { loseResponse = value; },
    resultFails(value: boolean) { resultFailure = value; },
    closeFails(value: boolean) { closeFailure = value; },
    status(value: string) { status = value; },
    output(value: Record<string, unknown>) { output = value; },
    get resultReads() { return resultReads; },
    async restart(resolver?: (id: string) => string) { await runner.stop(); runner = new TranscriptionRunner(queue, transcripts, request, resolver); },
  };
}

test('队列：提交成功但响应丢失，重启后以同一幂等键找回任务', async (t) => {
  const h = await harness(t);
  h.responseLost(true);
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 1);
  assert.equal(h.queue.get('episode')?.phase, 'submitting');
  await h.restart();
  h.responseLost(false);
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 1);
  assert.equal(h.queue.get('episode')?.task_id, h.platform.listTasks().tasks[0].task_id);
});

test('队列：成功结果读取失败保留待入库状态，重启补偿，不重复转写', async (t) => {
  const h = await harness(t);
  await h.runner.tick();
  h.status('succeeded');
  h.resultFails(true);
  await h.runner.tick();
  assert.equal(h.queue.get('episode')?.phase, 'saving');
  assert.equal(h.queue.get('episode')?.status, 'running');
  assert.equal(h.transcripts.count(), 0);
  await h.restart();
  h.resultFails(false);
  await h.runner.tick();
  assert.equal(h.queue.get('episode')?.status, 'done');
  assert.equal(h.transcripts.count(), 1);
  assert.equal(h.platform.listTasks().tasks.length, 1);
});

test('队列：提交响应丢失后身份归一，仍用原始输入找回任务，按新身份入库', async (t) => {
  const h = await harness(t);
  h.responseLost(true);
  await h.runner.tick();
  await h.restart(() => 'canonical-episode');
  h.responseLost(false);
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 1);
  assert.ok(h.queue.get('episode')?.task_id);
  h.status('succeeded');
  await h.runner.tick();
  assert.equal(h.transcripts.getByEpisode('canonical-episode')?.text, 'Recovered transcript');
});

test('队列：修复旧版本完成但未入库的记录', async (t) => {
  const h = await harness(t);
  await h.runner.tick();
  h.queue.markDone('episode');
  h.status('succeeded');
  await h.restart();
  assert.equal(h.queue.get('episode')?.phase, 'saving');
  await h.runner.tick();
  assert.equal(h.transcripts.count(), 1);
  assert.equal(h.queue.get('episode')?.status, 'done');
});

test('队列：取消失败保留任务关联；提交响应丢失时先找回再关闭', async (t) => {
  const h = await harness(t);
  h.responseLost(true);
  await h.runner.tick();
  h.responseLost(false);
  h.closeFails(true);
  await assert.rejects(h.runner.cancel('episode'), /close failed/);
  assert.equal(h.queue.get('episode')?.status, 'running');
  assert.ok(h.queue.get('episode')?.task_id);
  h.closeFails(false);
  assert.equal(await h.runner.cancel('episode'), true);
  assert.equal(h.queue.get('episode')?.status, 'canceled');
  assert.equal(h.platform.listTasks().tasks.length, 1);
  const key = h.queue.get('episode')!.request_key;
  h.queue.retry('episode');
  assert.notEqual(h.queue.get('episode')!.request_key, key);
});

test('队列：已有v2默认跳过，显式强制转写仍提交新任务', async (t) => {
  const h = await harness(t);
  h.transcripts.save({ taskId: 'old-task', episodeId: 'episode', language: 'zh', provider: 'test', model: '',
    text: 'Existing', segments: [{ start: 0, end: 1, text: 'Existing', speaker_id: 'speaker_1' }],
    version: 2, diarization: { provider: 'pyannote', model: 'test' }, artifactId: null, durationSeconds: null });
  await h.runner.tick();
  assert.equal(h.queue.get('episode')?.status, 'done');
  assert.equal(h.platform.listTasks().tasks.length, 0);
  assert.deepEqual(h.queue.add([{ episode_id: 'episode', show_id: 'show', title: 'Title', audio_url: 'https://example.com/audio.mp3', force: true }]),
    { added: 1, skipped: 0 });
  await h.restart();
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 1);
});

test('队列：已有v1仍创建v2，默认提交版本为2', async (t) => {
  const h = await harness(t);
  h.transcripts.save({ taskId: 'old', episodeId: 'episode', language: 'zh', provider: 'test', model: '',
    text: 'old', segments: [], artifactId: null, durationSeconds: null });
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 1);
  assert.equal(JSON.parse(h.queue.get('episode')!.submission_json!).version, 2);
});

test('队列：已完成v1升级使用当前音源和元数据，保留在途输入', async (t) => {
  const h = await harness(t);
  h.queue.saveSubmission('episode', { audio_url: 'https://example.com/expired.mp3' });
  const oldKey = h.queue.get('episode')!.request_key;
  h.queue.markDone('episode');
  h.queue.add([{ episode_id: 'episode', show_id: 'new-show', title: 'Updated title',
    audio_url: 'https://example.com/current.mp3', regenerate: true }]);
  assert.notEqual(h.queue.get('episode')!.request_key, oldKey);
  await h.runner.tick();
  const frozen = h.queue.get('episode')!.submission_json;
  assert.deepEqual(JSON.parse(frozen!), { audio_url: 'https://example.com/current.mp3',
    episode_id: 'episode', show_id: 'new-show', title: 'Updated title', language: 'zh', version: 2 });
  assert.deepEqual(h.queue.add([{ episode_id: 'episode', show_id: 'third-show', title: 'Next',
    audio_url: 'https://example.com/next.mp3', regenerate: true, force: true }]), { added: 0, skipped: 1 });
  assert.equal(h.queue.get('episode')!.submission_json, frozen);
  assert.equal(h.queue.get('episode')!.audio_url, 'https://example.com/current.mp3');
});

test('队列：v1升级排队后已有v2时二次去重，不强制重复转写', async (t) => {
  const h = await harness(t);
  h.queue.markDone('episode');
  h.queue.add([{ episode_id: 'episode', show_id: 'show', title: 'Title',
    audio_url: 'https://example.com/current.mp3', regenerate: true }]);
  h.transcripts.save({ taskId: 'other-v2-task', episodeId: 'episode', language: 'zh', provider: 'test', model: '',
    text: 'Already generated', segments: [{ start: 0, end: 1, text: 'Already generated', speaker_id: 'speaker_1' }],
    version: 2, diarization: { provider: 'pyannote', model: 'test' }, artifactId: null, durationSeconds: null });
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 0);
  assert.equal(h.queue.get('episode')?.status, 'done');
  assert.equal(h.queue.get('episode')?.force, false);
});

for (const cancel of [false, true]) test(`队列：无效v2结果终止补偿并暂停（cancel=${cancel}）`, async (t) => {
  const h = await harness(t);
  await h.runner.tick();
  h.status('succeeded');
  h.output({ text: 'v1 output', segments: [] });
  if (cancel) await assert.rejects(h.runner.cancel('episode'), /TRANSCRIPT/);
  else await h.runner.tick();
  assert.equal(h.queue.get('episode')?.status, 'failed');
  assert.equal(h.queue.get('episode')?.phase, null);
  assert.ok(h.queue.get('episode')?.task_id);
  assert.equal(h.queue.getState('paused'), '1');
  assert.equal(h.transcripts.count(), 0);
  const reads = h.resultReads;
  await h.restart();
  await h.runner.tick();
  assert.equal(h.resultReads, reads);
});

test('队列：旧冻结输入不改写，无版本历史输出按v1入库', async (t) => {
  const h = await harness(t);
  h.queue.saveSubmission('episode', { audio_url: 'https://example.com/audio.mp3', episode_id: 'episode' });
  await h.runner.tick();
  h.output({ text: 'legacy', segments: [] });
  h.status('succeeded');
  await h.runner.tick();
  assert.equal(h.transcripts.getByEpisode('episode')?.version, 1);
});
