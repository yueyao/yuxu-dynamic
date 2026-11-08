import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatformServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { createWebServer } from '../web/server.ts';

const PASSWORD = 'a-long-test-password';

function listen(server: ReturnType<typeof createWebServer>): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }));
}

function close(server: ReturnType<typeof createWebServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('Web：登录会话跨服务重启保留', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-web-session-'));
  const dbPath = join(directory, 'taskbase.sqlite');
  const platformStore = new Store(dbPath, { leaseMs: 60_000 });
  platformStore.bootstrap('owner', PASSWORD);
  const platformServer = createPlatformServer(platformStore, {
    artifactDir: join(directory, 'artifacts'),
    sweepMs: 1_000_000,
    schedulerMs: 1_000_000,
    requestLog: () => {},
  });
  await new Promise<void>((resolve) => platformServer.listen(0, '127.0.0.1', resolve));
  const platformUrl = `http://127.0.0.1:${(platformServer.address() as AddressInfo).port}`;
  const options = { platformUrl, dbPath, requestLog: () => {} };

  let webServer = createWebServer(options);
  const firstUrl = await listen(webServer);
  const login = await fetch(`${firstUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^tb_session=/);
  assert.equal((await fetch(`${firstUrl}/api/me`, { headers: { cookie } })).status, 200);

  await close(webServer);
  webServer = createWebServer(options);
  const secondUrl = await listen(webServer);

  t.after(async () => {
    await close(webServer);
    await new Promise<void>((resolve) => platformServer.close(() => resolve()));
    platformStore.closeDb();
    await rm(directory, { recursive: true, force: true });
  });

  const restored = await fetch(`${secondUrl}/api/me`, { headers: { cookie } });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as { username: string }).username, 'owner');
});
