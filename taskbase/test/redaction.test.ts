import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { PlatformError, Store } from '../src/store.ts';
import { createPlatformServer } from '../src/server.ts';
import { createWebServer } from '../web/server.ts';
import { WorkerClient, type WorkerLease } from '../src/worker-sdk.ts';
import { diagnosticMessage, redactText } from '../src/redact.ts';
import { PodcastStore } from '../src/podcast/store.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';

const sensitive = 'https://url-user:url-password@media.example/audio.mp3?signature=url-signature#url-fragment';
const message = `下载失败 ${sensitive} Authorization: Bearer bearer-secret; password="a password"; api_key=key-secret; Cookie: tb_session=cookie-secret; other=also-secret`;

function assertSafe(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of ['url-user', 'url-password', 'url-signature', 'url-fragment', 'bearer-secret',
    'a password', 'key-secret', 'cookie-secret', 'also-secret']) assert.ok(!text.includes(secret), `泄漏 ${secret}`);
  assert.match(text, /media\.example\/audio\.mp3/);
}

test('日志、进度、失败和关闭原因脱敏；业务输入保持原值', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-redaction-'));
  const store = new Store(join(dir, 'db.sqlite'));
  t.after(async () => { store.closeDb(); await rm(dir, { recursive: true, force: true }); });
  store.upsertApp({ app_id: 'safe', display_name: 'Safe', tasks: [{ task_key: 'run', display_name: 'Run',
    input_schema: { type: 'object' }, output_schema: { type: 'object' } }] });
  const task = store.createTask('owner', 'safe', 'run', { audio_url: sensitive }).task;
  const lease = store.lease('safe')!;
  store.log(task.task_id, lease.attempt_id, 'safe', 'error', message);
  store.progress(task.task_id, lease.attempt_id, 'safe', 20, message);
  store.fail(task.task_id, lease.attempt_id, 'safe', message);
  assertSafe(store.getLogs(task.task_id));
  assertSafe(store.getEvents(task.task_id));
  assertSafe(store.getTask(task.task_id).error);
  assert.equal((store.getTask(task.task_id).input as { audio_url: string }).audio_url, sensitive);
  // 同一原始错误的重复失败上报仍幂等。
  assert.doesNotThrow(() => store.fail(task.task_id, lease.attempt_id, 'safe', message));
  const closed = store.createTask('owner', 'safe', 'run', {}).task;
  assertSafe(store.close(closed.task_id, 'owner', message).close_reason);
});

test('Worker 上报日志/进度/失败前脱敏，避免在 HTTP 载荷中传播秘密', async () => {
  const bodies: unknown[] = [];
  const client = new WorkerClient({ baseUrl: 'http://fixture.invalid', token: 'worker-fixture-token',
    fetchImpl: async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); },
  });
  const lease: WorkerLease = { task_id: 'task', attempt_id: 'attempt', app_id: 'safe', task_key: 'run',
    input: {}, steps: {}, deadline_at: new Date(Date.now() + 60_000).toISOString(), schedule_id: null, planned_fire_time: null };
  await client.log(lease, 'info', message);
  await client.progress(lease, 1, message);
  await client.fail(lease, message);
  bodies.forEach(assertSafe);
});

test('诊断脱敏覆盖 JSON/环境秘密、重复脱敏与先脱敏后截断', () => {
  const previous = process.env.YUXUN_REDACTION_TEST_SECRET;
  process.env.YUXUN_REDACTION_TEST_SECRET = 'configured-secret-value';
  try {
    const raw = JSON.stringify({ access_token: 'json-token-secret', password: 'quoted \\" secret',
      detail: 'configured-secret-value', audio_url: sensitive });
    const safe = redactText(raw);
    for (const value of ['json-token-secret', 'quoted', 'configured-secret-value', 'url-signature']) {
      assert.ok(!safe.includes(value), `泄漏 ${value}`);
    }
    assert.equal(redactText(safe), safe);
    assert.doesNotMatch(diagnosticMessage(new Error(`password=${'x'.repeat(2000)}`)), /xxxx/);
    assert.equal(diagnosticMessage(new Error('任务失败 TASK_FAILED request_id=req-123')), '任务失败 TASK_FAILED request_id=req-123');
  } finally {
    if (previous === undefined) delete process.env.YUXUN_REDACTION_TEST_SECRET;
    else process.env.YUXUN_REDACTION_TEST_SECRET = previous;
  }
});

test('播客采集记录与转写队列错误均脱敏，服务端应用错误不保留秘密', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-app-redaction-'));
  const podcasts = new PodcastStore(join(dir, 'db.sqlite'));
  const queue = new TranscriptionQueueStore(join(dir, 'db.sqlite'));
  t.after(async () => { queue.close(); podcasts.close(); await rm(dir, { recursive: true, force: true }); });
  const show = podcasts.addShow({ url: 'https://example.com/show', title: 'Show' });
  podcasts.markSync(show.show_id, { status: 'failed', error: message });
  podcasts.recordRun({ taskId: null, showId: show.show_id, since: null, until: null,
    status: 'failed', inserted: 0, updated: 0, error: message, startedAt: Date.now() });
  assertSafe(podcasts.getShow(show.show_id).last_error);
  assertSafe(podcasts.listRuns(show.show_id));
  queue.add([{ episode_id: 'episode', show_id: show.show_id, title: 'Episode', audio_url: sensitive }]);
  queue.setError('episode', message);
  assertSafe(queue.get('episode')?.error);
  queue.markFailed('episode', message);
  assertSafe(queue.get('episode')?.error);
  queue.setState('error', message);
  assertSafe(queue.getState('error'));
});

test('HTTP：平台进度先脱敏再截断，API/Web 错误响应与控制台均脱敏', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-http-redaction-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const platform = createPlatformServer(store, { artifactDir: join(dir, 'artifacts'), requestLog: () => {} });
  const web = createWebServer({ platformUrl: 'http://fixture.invalid', dbPath: join(dir, 'db.sqlite'), requestLog: () => {},
    fetchImpl: async () => Response.json({ error: { code: 'FIXTURE_FAILURE', message } }, { status: 502 }) });
  t.after(async () => {
    for (const server of [web, platform]) await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeDb(); await rm(dir, { recursive: true, force: true });
  });
  for (const server of [platform, web]) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  const webBase = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const token = store.upsertApp({ app_id: 'safe', display_name: 'Safe', tasks: [{ task_key: 'run', display_name: 'Run',
    input_schema: { type: 'object' }, output_schema: { type: 'object' } }] }).worker_token!;
  const task = store.createTask('owner', 'safe', 'run', {}).task;
  const lease = store.lease('safe')!;
  const response = await fetch(`${base}/v1/worker/tasks/${task.task_id}/progress`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-attempt-id': lease.attempt_id, 'content-type': 'application/json' },
    body: JSON.stringify({ progress: 10, message: `password=${'x'.repeat(2000)} https://media.example/audio.mp3` }) });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.doesNotMatch(JSON.stringify(store.getEvents(task.task_id)), /xxxx/);
  t.mock.method(store, 'health', () => { throw new PlatformError(503, 'FIXTURE_FAILURE', message); });
  const known = await fetch(`${base}/health`);
  assert.equal(known.status, 503); assertSafe(await known.json());
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => { logged.push(values); });
  t.mock.method(store, 'health', () => { throw new Error(message); });
  const unknown = await fetch(`${base}/health`);
  assert.equal(unknown.status, 500); await unknown.arrayBuffer();
  assertSafe(logged);
  const webError = await fetch(`${webBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'test-password' }) });
  assert.equal(webError.status, 502); assertSafe(await webError.json());
});
