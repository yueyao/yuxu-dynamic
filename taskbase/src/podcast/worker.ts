#!/usr/bin/env node
/** 播客 Worker：抓节目页 → 过滤日期 → 入库；只存列表元数据，不下载音频。 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.ts';
import { RemoteError, WorkerClient, sleep, type WorkerLease } from '../worker-sdk.ts';
import { PODCAST_APP_ID } from './manifest.ts';
import { fetchShowPage, parseXiaoyuzhouShow } from './parser.ts';
import { fetchFeed, parseFeedXml } from './rss.ts';
import { PodcastStore, type ParsedEpisode, type PodcastShow } from './store.ts';

export type PodcastWorkerOptions = {
  dataDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollMs?: number;
};

type DateRange = { since: string; until: string; sinceMs: number; untilMs: number };

type ShowResult = {
  show_id: string;
  title: string;
  url: string;
  page_episodes: number;
  total_episodes: number;
  selected_episodes: number;
  inserted: number;
  updated: number;
  coverage_status: string;
  error: string | null;
};

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeDateRange(since?: string, until?: string, now = Date.now()): DateRange {
  const nowDate = new Date(now);
  const defaultUntil = dateOnly(nowDate);
  const oneYearAgo = new Date(nowDate);
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
  const defaultSince = dateOnly(oneYearAgo);
  const sinceValue = since ?? defaultSince;
  const untilValue = until ?? defaultUntil;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceValue) || !/^\d{4}-\d{2}-\d{2}$/.test(untilValue)) {
    throw new Error('日期范围必须是 YYYY-MM-DD');
  }
  const sinceMs = Date.parse(`${sinceValue}T00:00:00.000Z`);
  const untilMs = Date.parse(`${untilValue}T23:59:59.999Z`);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) throw new Error('日期范围无效');
  if (sinceMs > untilMs) throw new Error('since 不能晚于 until');
  return { since: sinceValue, until: untilValue, sinceMs, untilMs };
}

export function filterEpisodes(episodes: ParsedEpisode[], range: DateRange): ParsedEpisode[] {
  return episodes.filter((episode) => {
    if (!episode.publishedAt) return false;
    const published = Date.parse(episode.publishedAt);
    return Number.isFinite(published) && published >= range.sinceMs && published <= range.untilMs;
  });
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

async function syncShow(store: PodcastStore, show: PodcastShow, range: DateRange,
  taskId: string, fetchImpl: typeof fetch, active: WorkerClient, lease: WorkerLease,
  percent: number): Promise<ShowResult> {
  const startedAt = Date.now();
  const base: ShowResult = {
    show_id: show.show_id,
    title: show.title,
    url: show.url,
    page_episodes: 0,
    total_episodes: 0,
    selected_episodes: 0,
    inserted: 0,
    updated: 0,
    coverage_status: 'unknown',
    error: null,
  };
  try {
    await active.progress(lease, percent, `抓取《${show.title}》`);
    if (show.rss_url) {
      const xml = await fetchFeed(show.rss_url, fetchImpl);
      const parsed = parseFeedXml(xml);
      const selected = filterEpisodes(parsed.episodes, range);
      const coverage = 'full';
      store.updateMetadata(show.show_id, {
        title: parsed.title,
        author: parsed.author,
        description: parsed.description,
        coverUrl: parsed.coverUrl,
        totalEpisodeCount: parsed.episodes.length,
        pageEpisodeCount: parsed.episodes.length,
        coverageStatus: coverage,
      });
      const counts = store.upsertEpisodes(show.show_id, selected, 'rss');
      store.markSync(show.show_id, { status: 'succeeded', error: null, coverageStatus: coverage });
      store.recordRun({
        taskId, showId: show.show_id, since: range.since, until: range.until, status: 'succeeded',
        pageEpisodeCount: parsed.episodes.length, inserted: counts.inserted,
        updated: counts.updated, coverageStatus: coverage, error: null, startedAt,
      });
      await active.log(lease, 'info',
        `${parsed.title}：RSS 共 ${parsed.episodes.length} 集，区间内 ${selected.length} 集，新增 ${counts.inserted}`);
      return {
        ...base,
        title: parsed.title,
        page_episodes: parsed.episodes.length,
        total_episodes: parsed.episodes.length,
        selected_episodes: selected.length,
        inserted: counts.inserted,
        updated: counts.updated,
        coverage_status: coverage,
      };
    }
    const html = await fetchShowPage(show.url, fetchImpl);
    const parsed = parseXiaoyuzhouShow(html, show.url);
    const selected = filterEpisodes(parsed.episodes, range);
    const coverage = parsed.totalEpisodeCount > parsed.pageEpisodeCount ? 'partial' : 'full';
    store.updateMetadata(show.show_id, {
      title: parsed.title,
      author: parsed.author,
      description: parsed.description,
      coverUrl: parsed.coverUrl,
      totalEpisodeCount: parsed.totalEpisodeCount,
      pageEpisodeCount: parsed.pageEpisodeCount,
      coverageStatus: coverage,
    });
    const counts = store.upsertEpisodes(show.show_id, selected, 'page');
    const status = coverage === 'partial' ? 'partial' : 'succeeded';
    store.markSync(show.show_id, { status, error: null, coverageStatus: coverage });
    store.recordRun({
      taskId, showId: show.show_id, since: range.since, until: range.until, status,
      pageEpisodeCount: parsed.pageEpisodeCount, inserted: counts.inserted,
      updated: counts.updated, coverageStatus: coverage, error: null, startedAt,
    });
    await active.log(lease, 'info',
      `${parsed.title}：页面 ${parsed.pageEpisodeCount}/${parsed.totalEpisodeCount} 集，区间内 ${selected.length} 集，新增 ${counts.inserted}`);
    return {
      ...base,
      title: parsed.title,
      page_episodes: parsed.pageEpisodeCount,
      total_episodes: parsed.totalEpisodeCount,
      selected_episodes: selected.length,
      inserted: counts.inserted,
      updated: counts.updated,
      coverage_status: coverage,
    };
  } catch (error) {
    const message = errorMessage(error);
    try {
      store.markSync(show.show_id, { status: 'failed', error: message });
      store.recordRun({
        taskId, showId: show.show_id, since: range.since, until: range.until,
        status: 'failed', inserted: 0, updated: 0, error: message, startedAt,
      });
    } catch {
      // 保留原始错误；记录失败不应覆盖它
    }
    await active.log(lease, 'error', `${show.title || show.url} 同步失败：${message}`);
    return { ...base, error: message };
  }
}

export async function executePodcastLease(client: WorkerClient, lease: WorkerLease,
  store: PodcastStore, options: PodcastWorkerOptions = {}): Promise<void> {
  if (lease.app_id !== PODCAST_APP_ID) throw new Error('不是播客应用的任务');
  if (lease.task_key !== 'shows/collect' && lease.task_key !== 'show/sync') {
    throw new Error('Podcast Worker 不支持该任务');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const raw = (lease.input ?? {}) as Record<string, unknown>;
  const range = normalizeDateRange(
    typeof raw.since === 'string' ? raw.since : undefined,
    typeof raw.until === 'string' ? raw.until : undefined,
    now(),
  );
  await client.withHeartbeat(lease, async (active) => {
    await active.log(lease, 'info', `播客任务开始：${lease.task_key}，区间 ${range.since} 至 ${range.until}`);
    let targets: PodcastShow[] = [];
    if (lease.task_key === 'show/sync') {
      if (typeof raw.show_id !== 'string' || raw.show_id.length === 0) throw new Error('缺少 show_id');
      targets = [store.getShow(raw.show_id)];
    } else {
      const ids = asStringArray(raw.show_ids);
      const urls = asStringArray(raw.show_urls);
      const seen = new Set<string>();
      for (const id of ids) {
        const show = store.getShow(id);
        if (!seen.has(show.show_id)) { targets.push(show); seen.add(show.show_id); }
      }
      for (const url of urls) {
        const show = store.ensureShowByUrl(url);
        if (!seen.has(show.show_id)) { targets.push(show); seen.add(show.show_id); }
      }
    }
    if (targets.length === 0) throw new Error('没有指定任何节目');
    const results: ShowResult[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const show = targets[index];
      const percent = Math.round(5 + ((index + 0.5) / targets.length) * 90);
      results.push(await syncShow(store, show, range, lease.task_id, fetchImpl, client, lease, percent));
    }
    const inserted = results.reduce((sum, result) => sum + result.inserted, 0);
    const updated = results.reduce((sum, result) => sum + result.updated, 0);
    const failed = results.filter((result) => result.error !== null).length;
    const output = { shows: results, inserted, updated, failed };
    if (failed === results.length) {
      await active.fail(lease, results[0]?.error ?? '全部节目同步失败');
      return;
    }
    await active.progress(lease, 100, '播客任务完成');
    await active.complete(lease, output);
  });
}

export async function runPodcastOnce(client: WorkerClient, store: PodcastStore,
  options: PodcastWorkerOptions = {}): Promise<boolean> {
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executePodcastLease(client, lease, store, options);
  } catch (error) {
    const stale = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    if (!stale) {
      console.error('播客任务执行失败', error);
      await client.fail(lease, errorMessage(error)).catch(() => {});
    }
  }
  return true;
}

async function main(): Promise<void> {
  const token = process.env.TASKBASE_WORKER_TOKEN;
  if (!token) throw new Error('请设置 TASKBASE_WORKER_TOKEN');
  const store = new PodcastStore(config.dbPath);
  const client = new WorkerClient({
    baseUrl: process.env.TASKBASE_URL ?? 'http://127.0.0.1:3333',
    token,
    heartbeatMs: Number(process.env.TASKBASE_HEARTBEAT_MS ?? 15_000),
  });
  const options: PodcastWorkerOptions = {
    dataDir: config.dataDir,
    pollMs: Number(process.env.TASKBASE_POLL_MS ?? 2_000),
  };
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  console.log('Podcast Worker 已启动');
  while (!controller.signal.aborted) {
    try {
      const worked = await runPodcastOnce(client, store, options);
      if (!worked) await sleep(options.pollMs ?? 2_000, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('Podcast Worker 循环出错', error);
      await sleep(3_000, controller.signal).catch(() => {});
    }
  }
  store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
