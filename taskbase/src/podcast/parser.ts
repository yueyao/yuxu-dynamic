/** 小宇宙公开节目页解析：读取 __NEXT_DATA__，只提取列表元数据，不下载音频。 */
import type { ParsedEpisode } from './store.ts';
import { SafeHttpClient } from '../transcription/safe-http.ts';

export type ParsedShow = {
  sourceUrl: string;
  podcastId: string | null;
  title: string;
  author: string | null;
  description: string | null;
  coverUrl: string | null;
  totalEpisodeCount: number;
  pageEpisodeCount: number;
  episodes: ParsedEpisode[];
};

type AnyRecord = Record<string, unknown>;

function record(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickImage(value: unknown): string | null {
  if (!record(value)) return null;
  return asString(value.picUrl) ?? asString(value.largePicUrl) ?? asString(value.middlePicUrl)
    ?? asString(value.smallPicUrl) ?? asString(value.thumbnailUrl);
}

export function parseXiaoyuzhouShow(html: string, sourceUrl: string): ParsedShow {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('页面中没有找到小宇宙 __NEXT_DATA__ 数据');
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('小宇宙页面数据不是有效 JSON');
  }
  if (!record(data) || !record(data.props) || !record(data.props.pageProps)) {
    throw new Error('小宇宙页面结构缺少 pageProps');
  }
  const podcast = data.props.pageProps.podcast;
  if (!record(podcast) || !asString(podcast.title)) {
    throw new Error('小宇宙页面中没有节目信息');
  }
  const rawEpisodes = Array.isArray(podcast.episodes) ? podcast.episodes : [];
  const episodes: ParsedEpisode[] = [];
  const seen = new Set<string>();
  for (const raw of rawEpisodes) {
    if (!record(raw)) continue;
    const sourceId = asString(raw.eid);
    const title = asString(raw.title);
    if (!sourceId || !title || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const enclosure = record(raw.enclosure) ? raw.enclosure : null;
    const pubDate = asString(raw.pubDate);
    episodes.push({
      sourceId,
      title,
      description: asString(raw.description) ?? asString(raw.shownotes),
      publishedAt: pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null,
      durationSeconds: asNumber(raw.duration),
      audioUrl: enclosure ? asString(enclosure.url) : null,
      imageUrl: pickImage(raw.image),
    });
  }
  episodes.sort((a, b) => {
    const left = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const right = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return right - left;
  });
  const totalEpisodeCount = asNumber(podcast.episodeCount) ?? episodes.length;
  return {
    sourceUrl,
    podcastId: asString(podcast.pid),
    title: asString(podcast.title) as string,
    author: asString(podcast.author),
    description: asString(podcast.description),
    coverUrl: pickImage(podcast.image),
    totalEpisodeCount,
    pageEpisodeCount: episodes.length,
    episodes,
  };
}

export async function fetchShowPage(url: string,
  client = new SafeHttpClient({}, { allowHttp: true }), signal?: AbortSignal): Promise<string> {
  const response = await client.getText(url, {
    maxBytes: 5 * 1024 * 1024,
    timeoutMs: 30_000,
    signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Taskbase/0.2',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  return response.text;
}
