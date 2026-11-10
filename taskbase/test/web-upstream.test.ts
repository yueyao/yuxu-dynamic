import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWebServer } from '../web/server.ts';

test('Web：平台断线/超时返回网关错误，后续请求仍可用；HTTPS Cookie 默认 Secure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-upstream-'));
  let failure: 'network' | 'timeout' | 'body' | 'secret' = 'network';
  const server = createWebServer({
    dbPath: join(directory, 'db.sqlite'), platformUrl: 'http://mock.invalid',
    publicUrl: 'https://taskbase.example.com', requestLog: () => {},
    fetchImpl: async (input) => {
      if (new URL(String(input)).pathname === '/v1/auth/login') {
        return Response.json({ token: 'test-token' });
      }
      if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (failure === 'secret') return Response.json({ error: { code: 'UPSTREAM_FAILURE',
        message: '下载 https://user:password@example.com/audio?signature=hidden#fragment token=hidden-token' } }, { status: 503 });
      if (failure === 'body') return new Response(new ReadableStream({
        start(controller) { controller.error(new Error('stream interrupted')); },
      }));
      throw new TypeError('upstream unavailable');
    },
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({
    username: 'owner', password: 'test-password',
  }) });
  const setCookie = login.headers.get('set-cookie')!;
  assert.match(setCookie, /; Secure/);
  const cookie = setCookie.split(';')[0];
  for (const [mode, status] of [['network', 502], ['timeout', 504], ['body', 502]] as const) {
    failure = mode;
    const result = await fetch(`${base}/api/platform/apps`, { headers: { cookie } });
    assert.equal(result.status, status);
    assert.ok(result.headers.get('x-request-id'));
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  }
  failure = 'secret';
  const error = await fetch(`${base}/api/platform/apps`, { headers: { cookie } });
  assert.equal(error.status, 503);
  const text = await error.text();
  assert.match(text, /UPSTREAM_FAILURE/);
  assert.doesNotMatch(text, /user:password|hidden|fragment/);
});
