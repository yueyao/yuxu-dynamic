import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';

test('转写队列：入队、排序、启停与状态流转', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-queue-'));
  const store = new TranscriptionQueueStore(join(directory, 'taskbase.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const added = store.add([
    { episode_id: 'a', show_id: 's1', title: 'A', audio_url: 'https://example.com/a.m4a' },
    { episode_id: 'b', show_id: 's1', title: 'B', audio_url: 'https://example.com/b.m4a' },
    { episode_id: 'c', show_id: 's2', title: 'C', audio_url: 'https://example.com/c.m4a' },
    { episode_id: 'a', show_id: 's1', title: 'A', audio_url: 'https://example.com/a.m4a' },
  ]);
  assert.equal(added.added, 3);
  assert.equal(added.skipped, 1);
  assert.deepEqual(store.list().map((item) => item.id), ['a', 'b', 'c']);

  assert.equal(store.move('c', 'up'), true);
  assert.deepEqual(store.list().map((item) => item.id), ['a', 'c', 'b']);
  assert.equal(store.move('a', 'up'), false);

  store.setEnabled('b', false);
  assert.equal(store.next()?.id, 'a');

  store.markRunning('a', 'task-1');
  store.updateProgress('a', 42);
  assert.equal(store.running()?.task_id, 'task-1');
  assert.equal(store.running()?.progress, 42);
  assert.equal(store.next()?.id, 'c');
  assert.throws(() => store.remove('a'), /运行中/);

  store.markDone('a');
  assert.equal(store.counts().done, 1);
  assert.equal(store.running(), null);

  store.markFailed('c', 'boom');
  assert.equal(store.counts().failed, 1);
  store.retry('c');
  assert.equal(store.get('c')?.status, 'pending');
  store.markCanceled('c');
  assert.equal(store.get('c')?.status, 'canceled');
  assert.equal(store.counts().canceled, 1);

  store.setState('paused', '1');
  assert.equal(store.getState('paused'), '1');
  store.setState('paused', null);
  assert.equal(store.getState('paused'), null);

  assert.equal(store.remove('b'), true);
  assert.deepEqual(store.list().map((item) => item.id), ['a', 'c']);
});
