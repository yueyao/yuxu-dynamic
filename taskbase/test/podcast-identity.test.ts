import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PodcastStore, type ParsedEpisode } from '../src/podcast/store.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';

const episode: ParsedEpisode = { sourceId: 'ep-123', title: 'Episode', description: null,
  publishedAt: '2026-11-01T00:00:00Z', durationSeconds: 60,
  audioUrl: 'https://example.com/audio.mp3', imageUrl: null };

test('单集：公开页切换 RSS 保持 ID，旧来源链接和已有转写仍可读', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-identity-'));
  const path = join(dir, 'db.sqlite');
  const store = new PodcastStore(path);
  const transcripts = new TranscriptionStore(path);
  t.after(async () => { store.close(); transcripts.close(); await rm(dir, { recursive: true, force: true }); });
  const show = store.addShow({ url: 'https://example.com/podcast' });
  store.upsertEpisodes(show.show_id, [episode], 'page');
  const id = store.listEpisodes(show.show_id)[0].episode_id;
  transcripts.save({ taskId: 'task', episodeId: id, language: 'zh', provider: 'test', model: '',
    text: 'Transcript', segments: [], artifactId: null, durationSeconds: 60 });
  const result = store.upsertEpisodes(show.show_id, [{ ...episode, sourceId: 'rss-guid' }], 'rss');
  assert.deepEqual(result, { inserted: 0, updated: 1 });
  assert.equal(store.listEpisodes(show.show_id).length, 1);
  assert.equal(store.listEpisodes(show.show_id)[0].episode_id, id);
  const rssId = createHash('sha256').update(`${show.show_id}|rss|rss-guid`).digest('hex');
  assert.equal(store.getEpisode(rssId)?.episode_id, id);
  assert.equal(transcripts.getByEpisode(id)?.task_id, 'task');
  // 没有相同音频地址时，小宇宙 RSS GUID 与公开页 eid 仍指向同一集。
  store.upsertEpisodes(show.show_id, [{ ...episode, sourceId: 'https://www.xiaoyuzhoufm.com/episode/ep-123', audioUrl: null }], 'rss');
  assert.equal(store.listEpisodes(show.show_id).length, 1);
  assert.equal(store.getEpisode(id)?.audio_url, episode.audioUrl);
  assert.equal(store.getEpisode(id)?.source, 'rss');
});

test('单集：旧库重复数据迁移保留转写、队列任务和历史 ID 别名', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-identity-migration-'));
  const path = join(dir, 'db.sqlite');
  let store = new PodcastStore(path);
  const show = store.addShow({ url: 'https://example.com/podcast' });
  store.upsertEpisodes(show.show_id, [episode], 'page');
  const original = store.listEpisodes(show.show_id)[0].episode_id;
  store.close();
  const queue = new TranscriptionQueueStore(path);
  queue.add([{ episode_id: 'old-rss-id', show_id: show.show_id, title: 'Episode', audio_url: episode.audioUrl! }]);
  queue.markRunning('old-rss-id', 'running-task');
  const transcripts = new TranscriptionStore(path);
  transcripts.save({ taskId: 'old-task', episodeId: 'old-rss-id', language: 'zh', provider: 'test', model: '',
    text: 'Old transcript', segments: [], artifactId: null, durationSeconds: 60 });
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO podcast_episodes SELECT 'old-rss-id', show_id, 'rss', 'rss-guid', title, description,
    published_at, duration_seconds, audio_url, image_url, created_at + 1, updated_at FROM podcast_episodes WHERE id = ?`).run(original);
  db.exec('DELETE FROM podcast_migrations WHERE version = 2; DELETE FROM podcast_episode_aliases;');
  db.close();
  store = new PodcastStore(path);
  t.after(async () => { store.close(); transcripts.close(); queue.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.listEpisodes(show.show_id).length, 1);
  assert.equal(store.getEpisode('old-rss-id')?.episode_id, original);
  assert.equal(transcripts.getByEpisode(original)?.task_id, 'old-task');
  assert.equal(queue.get(original)?.task_id, 'running-task');
  store.close();
  store = new PodcastStore(path);
  assert.equal(store.getEpisode('old-rss-id')?.episode_id, original);
});
