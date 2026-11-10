/** RSS 2.0 / Atom feed 解析：只取列表元数据，不下载音频。 */
import { XMLParser } from 'fast-xml-parser';
import type { ParsedEpisode } from './store.ts';
import { SafeHttpClient } from '../transcription/safe-http.ts';

export type ParsedFeed = {
  title: string;
  author: string | null;
  description: string | null;
  coverUrl: string | null;
  episodes: ParsedEpisode[];
};

type AnyRecord = Record<string, unknown>;

function record(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function text(value: unknown): string | null {
  const raw = first(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (record(raw)) {
    if (raw['#cdata'] !== undefined) return text(raw['#cdata']);
    if (raw['#text'] !== undefined) return text(raw['#text']);
    if (raw['@_href'] !== undefined) return text(raw['@_href']);
    if (raw['@_url'] !== undefined) return text(raw['@_url']);
    if (raw.name !== undefined) return text(raw.name);
  }
  return null;
}

function plain(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function imageFrom(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  const firstValue = first(value);
  if (!record(firstValue)) return null;
  return text(firstValue['@_href']) ?? text(firstValue.url) ?? text(firstValue['@_url']);
}

function parseDuration(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  return null;
}

function parseDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function enclosureUrl(value: unknown): string | null {
  const firstValue = first(value);
  if (!record(firstValue)) return null;
  return text(firstValue['@_url']);
}

function rssItems(channel: AnyRecord): AnyRecord[] {
  const raw = channel.item;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter(record);
}

function atomItems(feed: AnyRecord): AnyRecord[] {
  const raw = feed.entry;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter(record);
}

function atomLink(entry: AnyRecord): { link: string | null; audio: string | null } {
  const raw = entry.link;
  const links = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(record);
  let link: string | null = null;
  let audio: string | null = null;
  for (const item of links) {
    const href = text(item['@_href']);
    const rel = text(item['@_rel']) ?? 'alternate';
    if (rel === 'enclosure') audio = href;
    else if (!link) link = href;
  }
  return { link, audio };
}

export function parseFeedXml(xml: string): ParsedFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '#cdata',
    textNodeName: '#text',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  let document: AnyRecord;
  try {
    const parsed = parser.parse(xml) as unknown;
    if (!record(parsed)) throw new Error('XML 根节点无效');
    document = parsed;
  } catch (error) {
    throw new Error(`RSS XML 解析失败：${error instanceof Error ? error.message : '未知错误'}`);
  }

  const rss = record(document.rss) ? document.rss : null;
  const atom = record(document.feed) ? document.feed : null;
  if (!rss && !atom) throw new Error('不是有效的 RSS/Atom feed');

  let title: string | null = null;
  let author: string | null = null;
  let description: string | null = null;
  let coverUrl: string | null = null;
  const episodes: ParsedEpisode[] = [];
  const seen = new Set<string>();

  const channel = rss && record(rss.channel) ? first(rss.channel) as AnyRecord : null;
  if (channel) {
    title = text(channel.title) ?? text(channel['itunes:title']);
    author = text(channel['itunes:author']) ?? text(channel.author) ?? text(channel.managingEditor);
    description = plain(channel.description) ?? plain(channel['itunes:summary']);
    coverUrl = imageFrom(channel['itunes:image']) ?? imageFrom(channel.image);
    for (const item of rssItems(channel)) {
      const episodeTitle = plain(item.title) ?? plain(item['itunes:title']);
      const guid = text(item.guid) ?? text(item['itunes:guid']) ?? text(item.link);
      const audioUrl = enclosureUrl(item.enclosure);
      const sourceId = (guid ?? audioUrl ?? `${episodeTitle ?? ''}:${text(item.pubDate) ?? ''}`).slice(0, 500);
      if (!episodeTitle || !sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      episodes.push({
        sourceId,
        title: episodeTitle.slice(0, 500),
        description: plain(item.description) ?? plain(item['itunes:summary']),
        publishedAt: parseDate(item.pubDate),
        durationSeconds: parseDuration(item['itunes:duration']),
        audioUrl,
        imageUrl: imageFrom(item['itunes:image']) ?? coverUrl,
      });
    }
  } else if (atom) {
    title = text(atom.title);
    author = text(atom.author) ?? text(atom['itunes:author']);
    description = plain(atom.subtitle) ?? plain(atom.description);
    coverUrl = imageFrom(atom.image) ?? imageFrom(atom['itunes:image']);
    for (const entry of atomItems(atom)) {
      const link = atomLink(entry);
      const episodeTitle = plain(entry.title);
      const sourceId = (text(entry.id) ?? link.link ?? link.audio ?? episodeTitle ?? '').slice(0, 500);
      if (!episodeTitle || !sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      episodes.push({
        sourceId,
        title: episodeTitle.slice(0, 500),
        description: plain(entry.summary) ?? plain(entry.content),
        publishedAt: parseDate(entry.published) ?? parseDate(entry.updated),
        durationSeconds: null,
        audioUrl: link.audio,
        imageUrl: coverUrl,
      });
    }
  }

  if (!title) throw new Error('feed 缺少标题');
  if (episodes.length === 0) throw new Error('feed 中没有可识别的单集');
  episodes.sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightTime - leftTime;
  });
  return {
    title,
    author,
    description,
    coverUrl,
    episodes,
  };
}

export async function fetchFeed(url: string,
  client = new SafeHttpClient({}, { allowHttp: true }), signal?: AbortSignal): Promise<string> {
  const response = await client.getText(url, {
    maxBytes: 20 * 1024 * 1024,
    timeoutMs: 45_000,
    signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Taskbase/0.2',
      accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
    },
  });
  const xml = response.text;
  const head = xml.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new Error('返回的是 HTML 而不是 RSS');
  }
  return xml;
}
