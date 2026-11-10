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
  const request: PlatformRequest = async <T>(path: string, init?: Parameters<PlatformRequest>[1]): Promise<T> => {
    if (path === '/v1/tasks') {
      const body = init!.body as { input: unknown };
      const created = platform.createTask('user:owner', 'transcription-tools', 'episode/transcribe', body.input, init!.idempotencyKey!);
      if (loseResponse) throw new TypeError('response lost after commit');
      return created as T;
    }
    if (path.endsWith('/result')) {
      if (resultFailure) throw new Error('temporary result failure');
      return { output: { text: 'Recovered transcript', language: 'zh', segments: [] } } as T;
    }
    if (path.endsWith('/close')) {
      if (closeFailure) throw new Error('close failed');
      return { status: 'closed' } as T;
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

test('队列：已有稿件默认跳过，显式强制转写仍提交新任务', async (t) => {
  const h = await harness(t);
  h.transcripts.save({ taskId: 'old-task', episodeId: 'episode', language: 'zh', provider: 'test', model: '',
    text: 'Existing', segments: [], artifactId: null, durationSeconds: null });
  await h.runner.tick();
  assert.equal(h.queue.get('episode')?.status, 'done');
  assert.equal(h.platform.listTasks().tasks.length, 0);
  assert.deepEqual(h.queue.add([{ episode_id: 'episode', show_id: 'show', title: 'Title', audio_url: 'https://example.com/audio.mp3', force: true }]),
    { added: 1, skipped: 0 });
  await h.restart();
  await h.runner.tick();
  assert.equal(h.platform.listTasks().tasks.length, 1);
});
