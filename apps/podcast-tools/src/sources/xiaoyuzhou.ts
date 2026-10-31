import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { ResolvedEpisode } from '../types.ts';

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];

type XiaoyuzhouEpisode = {
  id?: string;
  eid?: string;
  title?: string;
  enclosure?: { url?: string };
  media?: { source?: { url?: string } };
};

const XIAOYUZHOU_HOST = 'www.xiaoyuzhoufm.com';

/** 从公开小宇宙单集 HTML 提取规范化元数据和媒体地址。 */
export function resolveXiaoyuzhouEpisodeFromHtml(input: string, html: string): ResolvedEpisode {
  const inputUrl = new URL(input);
  if (inputUrl.protocol !== 'https:' || inputUrl.hostname !== XIAOYUZHOU_HOST ||
    !inputUrl.pathname.startsWith('/episode/')) {
    throw new Error('INVALID_SOURCE_URL: 不是受支持的小宇宙单集 HTTPS URL');
  }

  const document = parse(html);
  const nextDataElement = findElement(document, (element) => element.tagName === 'script' &&
    attribute(element, 'id') === '__NEXT_DATA__' &&
    attribute(element, 'type')?.toLowerCase() === 'application/json');
  if (!nextDataElement) throw new Error('SOURCE_PARSE_FAILED: 页面缺少 __NEXT_DATA__');

  let nextData: unknown;
  try {
    nextData = JSON.parse(textContent(nextDataElement));
  } catch {
    throw new Error('SOURCE_PARSE_FAILED: __NEXT_DATA__ 不是有效 JSON');
  }
  const episode = episodePayload(nextData);
  const mediaUrl = episode.enclosure?.url ?? episode.media?.source?.url ?? ogAudio(document);
  if (!mediaUrl) throw new Error('SOURCE_PARSE_FAILED: 页面缺少音频地址');
  const parsedMediaUrl = new URL(mediaUrl);
  if (parsedMediaUrl.protocol !== 'https:') {
    throw new Error('SOURCE_PARSE_FAILED: 音频地址必须使用 HTTPS');
  }

  const episodeId = episode.eid?.trim() || episode.id?.trim() ||
    inputUrl.pathname.split('/').filter(Boolean).at(-1);
  const title = episode.title?.trim();
  if (!episodeId || !title) throw new Error('SOURCE_PARSE_FAILED: 页面缺少单集 ID 或标题');

  inputUrl.hash = '';
  return {
    platform: 'xiaoyuzhou',
    canonicalUrl: inputUrl.toString(),
    episodeId,
    title,
    mediaUrl: parsedMediaUrl.toString(),
    resolverVersion: 'xiaoyuzhou-html-v1',
  };
}

function episodePayload(value: unknown): XiaoyuzhouEpisode {
  const root = asRecord(value);
  const pageProps = asRecord(asRecord(root?.props)?.pageProps);
  const direct = asRecord(pageProps?.episode);
  if (direct) return direct as XiaoyuzhouEpisode;

  const state = asRecord(pageProps?.dehydratedState);
  for (const query of Array.isArray(state?.queries) ? state.queries : []) {
    const episode = asRecord(asRecord(asRecord(query)?.state)?.data)?.episode;
    if (asRecord(episode)) return episode as XiaoyuzhouEpisode;
  }
  throw new Error('SOURCE_PARSE_FAILED: 无法定位单集数据');
}

function ogAudio(root: HtmlNode): string | undefined {
  const meta = findElement(root, (element) => element.tagName === 'meta' &&
    attribute(element, 'property')?.toLowerCase() === 'og:audio');
  return meta ? attribute(meta, 'content') : undefined;
}

function findElement(node: HtmlNode, predicate: (element: HtmlElement) => boolean): HtmlElement | undefined {
  if ('tagName' in node && predicate(node)) return node;
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function textContent(node: HtmlNode): string {
  if ('value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
