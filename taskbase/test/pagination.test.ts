import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, PlatformError } from '../src/store.ts';
import { PodcastStore } from '../src/podcast/store.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';

test('分页：节目与队列在服务端筛选，跨页无重复或遗漏', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-pagination-'));
  const path = join(dir, 'db.sqlite');
  const shows = new PodcastStore(path);
  const queue = new TranscriptionQueueStore(path);
  t.after(async () => { queue.close(); shows.close(); await rm(dir, { recursive: true, force: true }); });
  const active = shows.addShow({ url: 'https://example.com/active', title: 'Active' });
  shows.markSync(active.show_id, { status: 'succeeded' });
  for (let i = 0; i < 7; i++) {
    const show = shows.addShow({ url: `https://example.com/candidate-${i}`, title: `Candidate ${i}` });
    queue.add([{ episode_id: `episode-${i}`, show_id: show.show_id, title: `Episode ${i}`, audio_url: 'https://example.com/audio.mp3' }]);
  }
  const archived = shows.addShow({ url: 'https://example.com/ignored', title: 'Ignored' });
  shows.setArchived(archived.show_id, true);
  const ids: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const result = shows.listShowsPage({ mode: 'candidate', page, limit: 3 });
    assert.equal(result.total, 7);
    assert.deepEqual(result.counts, { active: 1, candidate: 7, archived: 1 });
    ids.push(...result.shows.map((show) => show.show_id));
  }
  assert.equal(new Set(ids).size, 7);
  assert.equal(shows.listShowsPage({ mode: 'candidate', query: 'Candidate 4' }).total, 1);
  assert.equal(shows.listShowsPage({ mode: 'candidate', archived: true }).total, 8);
  queue.markDone('episode-0');
  queue.markCanceled('episode-1');
  queue.markRunning('episode-2', 'task');
  const items = [1, 2, 3].flatMap((page) => queue.listPage({ page, limit: 2 }).items);
  assert.equal(new Set(items.map((item) => item.id)).size, 5);
  assert.equal(queue.listPage().total, 5);
  assert.equal(queue.listPage({ status: 'all' }).total, 7);
  assert.equal(queue.listPage({ status: 'running' }).items[0].id, 'episode-2');
  assert.equal(queue.listPage({ query: 'Candidate 4' }).total, 1);
});

test('分页：转写历史只读摘要，筛选总数与下一页准确，详情保留全文', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-transcript-page-'));
  const store = new TranscriptionStore(join(dir, 'db.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 7; i++) store.save({ taskId: `task-${i}`, episodeId: `episode-${i}`,
    title: `Match ${i}`, language: 'zh', provider: 'test', model: '', durationSeconds: 60,
    text: '完整转写内容'.repeat(1000), segments: [{ start: 0, end: 60, text: '片段' }], artifactId: null });
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = store.listMetadataPage({ limit: 3, offset, query: 'Match' });
    assert.equal(result.total, 7);
    for (const item of result.items) {
      assert.equal('text' in item, false);
      assert.equal(item.segments, 1);
      ids.push(item.task_id);
    }
    offset = result.next_offset;
  }
  assert.equal(new Set(ids).size, 7);
  assert.equal(store.listMetadataPage({ query: 'Match 4' }).total, 1);
  assert.equal(store.getByTask('task-4')?.text.length, 6000);
});

test('任务摘要不传完整结果；Worker 最近联系过期后离线；无效 cron 返回 400', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-task-summary-'));
  const store = new Store(join(dir, 'db.sqlite'));
  t.after(async () => { store.closeDb(); await rm(dir, { recursive: true, force: true }); });
  store.upsertApp({ app_id: 'transcription-tools', display_name: 'Test', tasks: [{
    task_key: 'echo', display_name: 'Echo', schedulable: true,
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: { text: { type: 'string' } } },
  }] });
  const created = store.createTask('owner', 'transcription-tools', 'echo', {});
  const lease = store.lease('transcription-tools')!;
  store.complete(lease.task_id, lease.attempt_id, 'transcription-tools', { text: 'large output' });
  assert.equal(store.listTasks({ summary: true }).tasks[0].output, null);
  assert.deepEqual(store.getTask(created.task.task_id).output, { text: 'large output' });
  assert.equal(store.listApps()[0].worker_online, false);
  store.markWorkerSeen('transcription-tools', Date.now() - 100_000);
  assert.equal(store.listApps()[0].worker_online, false);
  store.markWorkerSeen('transcription-tools');
  assert.equal(store.listApps()[0].worker_online, true);
  assert.ok(store.listApps()[0].last_worker_seen_at);
  assert.throws(() => store.createSchedule('transcription-tools', 'echo', {}, 'invalid', 'UTC'),
    (error) => error instanceof PlatformError && error.status === 400 && error.code === 'INVALID_CRON');
});
