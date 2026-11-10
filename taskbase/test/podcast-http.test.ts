import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fetchFeed } from '../src/podcast/rss.ts';
import { fetchShowPage } from '../src/podcast/parser.ts';
import { SafeHttpClient } from '../src/transcription/safe-http.ts';

test('播客抓取：拒绝私网、重定向私网、URL 凭据和保留 IPv6', async () => {
  let requests = 0;
  const client = new SafeHttpClient({
    resolveHost: async (host) => [{ address: host === 'private.test' ? '10.0.0.1' : '93.184.216.34', family: 4 }],
    request: async () => {
      requests++;
      return { statusCode: 302, headers: { location: 'http://private.test/rss' }, body: Readable.from([]) };
    },
  }, { allowHttp: true });
  for (const url of ['http://127.0.0.1/rss', 'https://private.test/rss', 'https://[::1]/rss', 'https://[::ffff:7f00:1]/rss']) {
    await assert.rejects(fetchFeed(url, client), /UNSAFE_ADDRESS/);
  }
  await assert.rejects(fetchFeed('https://user:password@public.test/rss', client), /UNSAFE_URL/);
  assert.equal(requests, 0);
  await assert.rejects(fetchFeed('http://public.test/rss', client), /UNSAFE_ADDRESS/);
  assert.equal(requests, 1);
});

test('播客抓取：按实际字节拦截无 Content-Length 的超限响应', async () => {
  const large = new SafeHttpClient({
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ statusCode: 200, headers: {}, body: Readable.from([
      Buffer.alloc(10 * 1024 * 1024), Buffer.alloc(11 * 1024 * 1024),
    ]) }),
  }, { allowHttp: true });
  await assert.rejects(fetchFeed('http://public.test/rss', large), /SOURCE_TOO_LARGE/);
  await assert.rejects(fetchShowPage('https://public.test/page', large), /SOURCE_TOO_LARGE/);
});

test('播客抓取：公开 HTTP RSS 可用，取消会停止读取', async () => {
  const controller = new AbortController();
  const client = new SafeHttpClient({
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (_url, _address, _timeout, _headers, signal) => {
      signal?.throwIfAborted();
      return { statusCode: 200, headers: {}, body: Readable.from(['<rss>ok</rss>']) };
    },
  }, { allowHttp: true });
  assert.equal(await fetchFeed('http://public.test/rss', client), '<rss>ok</rss>');
  controller.abort();
  await assert.rejects(fetchFeed('http://public.test/rss', client, controller.signal), { name: 'AbortError' });
});

test('播客抓取：DNS 等待与响应打开时的取消不会留下悬挂请求', async () => {
  const controller = new AbortController();
  const stalled = new SafeHttpClient({ resolveHost: () => new Promise(() => {}) });
  const pending = stalled.getText('https://public.test/rss', { timeoutMs: 10_000, maxBytes: 100, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  const duringOpen = new AbortController();
  const body = new Readable({ read() {} });
  const client = new SafeHttpClient({
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => {
      duringOpen.abort();
      return { statusCode: 200, headers: {}, body };
    },
  });
  await assert.rejects(client.getText('https://public.test/rss', { timeoutMs: 10_000, maxBytes: 100, signal: duringOpen.signal }), { name: 'AbortError' });
  assert.equal(body.destroyed, true);
});
