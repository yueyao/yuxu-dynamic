import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlatformServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { createWebServer } from '../web/server.ts';

const PASSWORD = 'a-long-test-password';
const publicDir = fileURLToPath(new URL('../web/public', import.meta.url));

test('Web：登录、管理代理、播客注册、节目、采集和调度', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-web-'));
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
  const webServer = createWebServer({
    platformUrl, dbPath, publicDir, requestLog: () => {},
    transcriptApiToken: 'test-transcript-token',
  });
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  const webUrl = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;

  t.after(async () => {
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
    await new Promise<void>((resolve) => platformServer.close(() => resolve()));
    platformStore.closeDb();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${webUrl}/api/me`)).status, 401);
  const page = await fetch(`${webUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Taskbase/);
  assert.equal((await fetch(`${webUrl}/app.js`)).status, 200);

  const loginResponse = await fetch(`${webUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = (loginResponse.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.startsWith('tb_session='));
  const loginData = await loginResponse.json() as { csrf_token: string; username: string };
  const csrf = loginData.csrf_token;

  const me = await fetch(`${webUrl}/api/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { username: string }).username, 'owner');

  const apps = await fetch(`${webUrl}/api/platform/apps`, { headers: { cookie } });
  assert.equal(apps.status, 200);
  assert.deepEqual((await apps.json() as { apps: unknown[] }).apps, []);

  const noCsrf = await fetch(`${webUrl}/api/podcast/shows`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.xiaoyuzhoufm.com/podcast/test' }),
  });
  assert.equal(noCsrf.status, 403);

  const register = await fetch(`${webUrl}/api/podcast/register`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  assert.equal(register.status, 200);
  const registerData = await register.json() as { worker_token?: string };
  assert.equal(typeof registerData.worker_token, 'string');

  const created = await fetch(`${webUrl}/api/podcast/shows`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ url: 'https://www.xiaoyuzhoufm.com/podcast/test', title: '测试播客' }),
  });
  assert.equal(created.status, 201);
  const createdData = await created.json() as { show: { show_id: string; title: string } };
  const showId = createdData.show.show_id;
  assert.equal(createdData.show.title, '测试播客');

  const shows = await fetch(`${webUrl}/api/podcast/shows`, { headers: { cookie } });
  assert.equal((await shows.json() as { shows: unknown[] }).shows.length, 1);

  const overview = await fetch(`${webUrl}/api/podcast/overview`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  const overviewData = await overview.json() as { app_registered: boolean; shows: number };
  assert.equal(overviewData.app_registered, true);
  assert.equal(overviewData.shows, 1);

  const collect = await fetch(`${webUrl}/api/podcast/collect`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ since: '2026-01-01', until: '2026-12-31' }),
  });
  assert.equal(collect.status, 202);
  const collectData = await collect.json() as { task: { app_id: string; task_key: string; status: string } };
  assert.equal(collectData.task.app_id, 'podcast-tools');
  assert.equal(collectData.task.task_key, 'shows/collect');
  assert.equal(collectData.task.status, 'queued');

  const tasks = await fetch(`${webUrl}/api/platform/tasks?app_id=podcast-tools`, { headers: { cookie } });
  const tasksData = await tasks.json() as { tasks: Array<{ task_id: string }> };
  assert.equal(tasksData.tasks.length, 1);

  const schedule = await fetch(`${webUrl}/api/podcast/shows/${showId}/schedule`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ cron: '0 9 * * *', timezone: 'Asia/Shanghai', since: '2026-01-01', until: '2026-12-31' }),
  });
  assert.equal(schedule.status, 201);
  const scheduleData = await schedule.json() as { schedule: { schedule_id: string; next_fire_at: string } };
  assert.ok(scheduleData.schedule.next_fire_at);

  const schedules = await fetch(`${webUrl}/api/podcast/schedules`, { headers: { cookie } });
  const schedulesData = await schedules.json() as { schedules: Array<{ show_title: string }> };
  assert.equal(schedulesData.schedules.length, 1);
  assert.equal(schedulesData.schedules[0].show_title, '测试播客');

  const episodes = await fetch(`${webUrl}/api/podcast/shows/${showId}/episodes`, { headers: { cookie } });
  assert.equal(episodes.status, 200);
  assert.deepEqual((await episodes.json() as { episodes: unknown[] }).episodes, []);

  const runs = await fetch(`${webUrl}/api/podcast/runs`, { headers: { cookie } });
  assert.equal(runs.status, 200);
  assert.ok(Array.isArray((await runs.json() as { runs: unknown[] }).runs));

  const transcripts = await fetch(`${webUrl}/api/transcription/transcripts`, { headers: { cookie } });
  assert.equal(transcripts.status, 200);
  assert.deepEqual((await transcripts.json() as { transcripts: unknown[] }).transcripts, []);

  const apiUnauthorized = await fetch(`${webUrl}/api/v1/transcripts`);
  assert.equal(apiUnauthorized.status, 401);
  const apiList = await fetch(`${webUrl}/api/v1/transcripts`, {
    headers: { authorization: 'Bearer test-transcript-token' },
  });
  assert.equal(apiList.status, 200);
  assert.deepEqual((await apiList.json() as { transcripts: unknown[] }).transcripts, []);
  const apiQueue = await fetch(`${webUrl}/api/v1/queue`, {
    headers: { authorization: 'Bearer test-transcript-token' },
  });
  assert.equal(apiQueue.status, 200);
  assert.deepEqual((await apiQueue.json() as { counts: Record<string, number> }).counts, {
    pending: 0, running: 0, done: 0, failed: 0, canceled: 0,
  });
  const apiMissing = await fetch(`${webUrl}/api/v1/transcripts/transcript-missing`, {
    headers: { authorization: 'Bearer test-transcript-token' },
  });
  assert.equal(apiMissing.status, 404);

  const logout = await fetch(`${webUrl}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${webUrl}/api/me`, { headers: { cookie } })).status, 401);
});
