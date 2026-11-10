import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { SafeHttpClient } from '../src/transcription/safe-http.ts';
import { parseXiaoyuzhouShow } from '../src/podcast/parser.ts';
import { parseFeedXml } from '../src/podcast/rss.ts';
import { PodcastStore, normalizeShowUrl } from '../src/podcast/store.ts';
import { executePodcastLease, filterEpisodes, normalizeDateRange } from '../src/podcast/worker.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';
import type { WorkerClient, WorkerLease } from '../src/worker-sdk.ts';

const fixturePath = new URL('./fixtures/xyz-show.html', import.meta.url);

test('解析小宇宙公开页并过滤日期', async () => {
  const html = await readFile(fixturePath, 'utf8');
  const parsed = parseXiaoyuzhouShow(html, 'https://www.xiaoyuzhoufm.com/podcast/test');
  assert.equal(parsed.title, '测试播客');
  assert.equal(parsed.author, '测试作者');
  assert.equal(parsed.totalEpisodeCount, 3);
  assert.equal(parsed.pageEpisodeCount, 2);
  assert.equal(parsed.episodes[0].publishedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(parsed.episodes[1].publishedAt, '2025-12-01T00:00:00.000Z');

  const range = normalizeDateRange('2026-01-01', '2026-12-31');
  const filtered = filterEpisodes(parsed.episodes, range);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, '第一集：新内容');
  assert.throws(() => parseXiaoyuzhouShow('<html></html>', 'https://example.com'));

  const defaultRange = normalizeDateRange(undefined, undefined, Date.parse('2026-11-07T00:00:00Z'));
  assert.equal(defaultRange.since, '2025-11-07');
  assert.equal(defaultRange.until, '2026-11-07');
});

test('播客表：新增、元数据、单集 upsert 与记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-podcast-'));
  const store = new PodcastStore(join(directory, 'taskbase.sqlite'));
  try {
    const url = normalizeShowUrl('https://www.xiaoyuzhoufm.com/podcast/abc/');
    assert.equal(url, 'https://www.xiaoyuzhoufm.com/podcast/abc');
    const show = store.addShow({ url, title: '测试节目' });
    assert.equal(store.getShowByUrl(url)?.show_id, show.show_id);
    assert.throws(() => store.addShow({ url }), /已经在库中/);
    const archived = store.setArchived(show.show_id, true);
    assert.ok(archived.archived_at);
    assert.equal(store.overview().archived_shows, 1);
    assert.equal(store.setArchived(show.show_id, false).archived_at, null);

    store.updateMetadata(show.show_id, {
      title: '正式标题', author: '作者', totalEpisodeCount: 3, pageEpisodeCount: 2, coverageStatus: 'partial',
    });
    const first = store.upsertEpisodes(show.show_id, [
      {
        sourceId: 'a', title: 'A', description: 'a', publishedAt: '2026-01-01T00:00:00.000Z',
        durationSeconds: 60, audioUrl: 'https://example.com/a.mp3', imageUrl: null,
      },
    ]);
    assert.deepEqual(first, { inserted: 1, updated: 0 });
    const second = store.upsertEpisodes(show.show_id, [
      {
        sourceId: 'a', title: 'A2', description: 'a2', publishedAt: '2026-01-01T00:00:00.000Z',
        durationSeconds: 61, audioUrl: 'https://example.com/a.mp3', imageUrl: null,
      },
      {
        sourceId: 'b', title: 'B', description: null, publishedAt: '2026-02-01T00:00:00.000Z',
        durationSeconds: null, audioUrl: null, imageUrl: null,
      },
    ]);
    assert.deepEqual(second, { inserted: 1, updated: 1 });
    assert.equal(store.listEpisodes(show.show_id).length, 2);
    const libraryByShow = store.listEpisodeLibrary({ q: '正式标题', limit: 10 });
    assert.equal(libraryByShow.total, 2);
    assert.equal(libraryByShow.episodes[0].show_title, '正式标题');
    assert.equal(libraryByShow.episodes.every((episode) => episode.transcript_id === null), true);
    assert.equal(store.listEpisodeLibrary({ showId: show.show_id, limit: 10 }).total, 2);
    assert.equal(store.listEpisodeLibrary({ sort: 'show_title', limit: 1 }).episodes.length, 1);
    store.markSync(show.show_id, { status: 'partial', coverageStatus: 'partial' });
    store.recordRun({
      taskId: 'task-1', showId: show.show_id, since: '2026-01-01', until: '2026-12-31',
      status: 'partial', pageEpisodeCount: 2, inserted: 1, updated: 0,
      coverageStatus: 'partial', startedAt: Date.now(),
    });
    const updated = store.getShow(show.show_id);
    assert.equal(updated.title, '正式标题');
    assert.equal(updated.last_sync_status, 'partial');
    assert.equal(updated.episode_count, 2);
    assert.equal(store.listRuns(show.show_id).length, 1);
    assert.equal(store.overview().shows, 1);
    assert.equal(store.overview().episodes, 2);
    assert.equal(updated.transcript_count, 0);

    // 有转写稿的单集数：按 episode 去重，并随 getShow / listShows / listShowsPage 返回
    const transcriptionStore = new TranscriptionStore(join(directory, 'taskbase.sqlite'));
    const episodeId = store.listEpisodes(show.show_id)[0].episode_id;
    for (const taskId of ['task-transcript-1', 'task-transcript-1-retry']) {
      transcriptionStore.save({
        taskId, episodeId, showId: show.show_id, title: 'B', language: 'zh',
        provider: 'test', model: 'test', durationSeconds: 60, text: '文字稿',
        segments: [], artifactId: null,
      });
    }
    assert.equal(store.getShow(show.show_id).transcript_count, 1);
    assert.equal(store.listShows()[0].transcript_count, 1);
    assert.equal(store.listShowsPage({ limit: 10 }).shows[0].transcript_count, 1);
    transcriptionStore.close();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('播客 Worker 执行 collect：日期过滤、partial 标记、输出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-podcast-worker-'));
  const store = new PodcastStore(join(directory, 'taskbase.sqlite'));
  try {
    const show = store.addShow({ url: 'https://www.xiaoyuzhoufm.com/podcast/test', title: '待同步' });
    const html = await readFile(fixturePath, 'utf8');
    const httpClient = new SafeHttpClient({
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({ statusCode: 200, headers: {}, body: Readable.from([html]) }),
    });
    const calls: { progress: number[]; logs: string[]; completed: unknown; failed: string | null } = {
      progress: [], logs: [], completed: null, failed: null,
    };
    const fake = {
      async withHeartbeat(_lease: WorkerLease, work: (client: WorkerClient, signal: AbortSignal) => Promise<unknown>) {
        return work(fake as unknown as WorkerClient, new AbortController().signal);
      },
      async log(_lease: WorkerLease, _level: string, message: string) { calls.logs.push(message); },
      async progress(_lease: WorkerLease, percent: number) { calls.progress.push(percent); },
      async complete(_lease: WorkerLease, output: unknown) { calls.completed = output; },
      async fail(_lease: WorkerLease, message: string) { calls.failed = message; },
    } as unknown as WorkerClient;
    const lease: WorkerLease = {
      task_id: 'task-1', attempt_id: 'attempt-1', app_id: 'podcast-tools', task_key: 'shows/collect',
      input: { show_ids: [show.show_id], since: '2026-01-01', until: '2026-12-31' },
      steps: {}, deadline_at: '2026-12-31T00:00:00.000Z', schedule_id: null, planned_fire_time: null,
    };
    await executePodcastLease(fake, lease, store, {
      httpClient, now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    });
    assert.equal(calls.failed, null);
    assert.ok(calls.completed);
    const output = calls.completed as { shows: Array<Record<string, unknown>>; inserted: number; updated: number; failed: number };
    assert.equal(output.inserted, 1);
    assert.equal(output.updated, 0);
    assert.equal(output.failed, 0);
    assert.equal(output.shows[0].coverage_status, 'partial');
    assert.equal(output.shows[0].selected_episodes, 1);
    assert.equal(store.listEpisodes(show.show_id).length, 1);
    assert.equal(store.listEpisodes(show.show_id)[0].title, '第一集：新内容');
    assert.equal(store.getShow(show.show_id).title, '测试播客');
    assert.equal(store.listRuns(show.show_id).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('解析 RSS feed：标题、时间、时长、音频与描述', async () => {
  const xml = await readFile(new URL('./fixtures/rss-show.xml', import.meta.url), 'utf8');
  const feed = parseFeedXml(xml);
  assert.equal(feed.title, '测试 RSS 栏目');
  assert.equal(feed.author, '测试作者');
  assert.equal(feed.coverUrl, 'https://example.com/cover.jpg');
  assert.equal(feed.episodes.length, 2);
  assert.equal(feed.episodes[0].sourceId, 'episode-001');
  assert.equal(feed.episodes[0].durationSeconds, 3723);
  assert.equal(feed.episodes[0].description, 'Hello 世界');
  assert.equal(feed.episodes[0].audioUrl, 'https://example.com/001.m4a');
  assert.equal(feed.episodes[0].publishedAt, '2026-11-05T10:00:00.000Z');
  assert.equal(feed.episodes[1].durationSeconds, 2710);
  assert.throws(() => parseFeedXml('<html></html>'));
});
