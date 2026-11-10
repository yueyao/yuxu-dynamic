import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlatformServer } from '../src/server.ts';
import { Store } from '../src/store.ts';

function manifest(maxBytes?: number) {
  return { app_id: 'limits', display_name: 'Limits', tasks: [{ task_key: 'run', display_name: 'Run',
    input_schema: { type: 'object' }, output_schema: { type: 'object' }, schedulable: true,
    artifact_policy: { required: false, ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }) } }] };
}

test('产物：定义与全局限额取小，声明长度及 chunked 实际超限不留文件或元数据', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-limits-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const artifactDir = join(dir, 'artifacts');
  const server = createPlatformServer(store, { artifactDir, maxArtifactBytes: 10, requestLog: () => {} });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeDb(); await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = store.upsertApp(manifest(4)).worker_token!;
  const id = store.createTask('owner', 'limits', 'run', {}).task.task_id;
  const lease = store.lease('limits')!;
  const endpoint = `${base}/v1/worker/tasks/${id}/artifacts?name=out.txt`;
  const headers = { authorization: `Bearer ${token}`, 'x-attempt-id': lease.attempt_id };
  const rejected = await fetch(endpoint, { method: 'PUT', headers, body: '12345' });
  assert.equal(rejected.status, 413);
  await rejected.arrayBuffer();
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = request(endpoint, { method: 'PUT', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.write('123'); req.end('45');
  });
  assert.equal(chunked, 413);
  assert.deepEqual(await readdir(artifactDir).catch(() => []), []);
  assert.equal(store.getEvents(id).filter((e) => e.type === 'artifact').length, 0);
  assert.throws(() => store.createArtifact(id, lease.attempt_id, 'limits', 'bypass', 'out.txt', 'text/plain', 5, 'hash'),
    (error: unknown) => (error as { status: number }).status === 413);
  const accepted = await fetch(endpoint, { method: 'PUT', headers, body: '1234' });
  assert.equal(accepted.status, 201); await accepted.arrayBuffer();
  // 调大定义不能突破全局限制。
  store.upsertApp(manifest(20));
  const globalRejected = await fetch(endpoint, { method: 'PUT', headers, body: '12345678901' });
  assert.equal(globalRejected.status, 413); await globalRejected.arrayBuffer();
  assert.equal((await readdir(artifactDir)).length, 1);
  const stale = await fetch(endpoint, { method: 'PUT', headers: { ...headers, 'x-attempt-id': 'old' }, body: 'x' });
  assert.equal(stale.status, 409); await stale.arrayBuffer();
  const otherToken = store.upsertApp({ ...manifest(), app_id: 'other' }).worker_token!;
  const wrongApp = await fetch(endpoint, { method: 'PUT', headers: { ...headers, authorization: `Bearer ${otherToken}` }, body: 'x'.repeat(20) });
  assert.equal(wrongApp.status, 403); await wrongApp.arrayBuffer();
  // 未声明定义限额时仍执行全局上限。
  store.upsertApp(manifest());
  const globalOnly = await fetch(endpoint, { method: 'PUT', headers, body: 'x'.repeat(11) });
  assert.equal(globalOnly.status, 413); await globalOnly.arrayBuffer();
  assert.equal((await readdir(artifactDir)).length, 1);
});

test('输入：任务和调度只接受不超过 64 KiB 的 JSON 对象，结果不受输入限额影响', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-input-limit-'));
  const store = new Store(join(dir, 'db.sqlite'));
  t.after(async () => { store.closeDb(); await rm(dir, { recursive: true, force: true }); });
  store.upsertApp(manifest());
  const exact = { text: 'a'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify({ text: '' }))) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 64 * 1024);
  const oversized = { text: '中'.repeat(23_000) };
  const isLimit = (error: unknown) => (error as { status: number; code: string }).status === 413
    && (error as { code: string }).code === 'INPUT_TOO_LARGE';
  for (const input of [null, [], 'text', 1]) {
    assert.throws(() => store.createTask('owner', 'limits', 'run', input),
      (error: unknown) => (error as { code: string }).code === 'INVALID_INPUT');
  }
  assert.throws(() => store.createTask('owner', 'limits', 'run', oversized), isLimit);
  assert.throws(() => store.createSchedule('limits', 'run', oversized, '* * * * *', 'UTC'), isLimit);
  const schedule = store.createSchedule('limits', 'run', {}, '* * * * *', 'UTC');
  assert.throws(() => store.updateSchedule(schedule.schedule_id, { input: oversized }), isLimit);
  assert.deepEqual(store.getSchedule(schedule.schedule_id).input, {});
  const task = store.createTask('owner', 'limits', 'run', exact).task;
  const lease = store.lease('limits')!;
  assert.equal(store.complete(task.task_id, lease.attempt_id, 'limits', oversized).status, 'succeeded');
  assert.equal(store.listTasks().tasks.length, 1);
});

test('旧数据：重试、立即调度和定时触发都重新检查输入上限', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-legacy-input-'));
  const dbPath = join(dir, 'db.sqlite');
  const store = new Store(dbPath);
  const legacy = new DatabaseSync(dbPath);
  t.after(async () => { legacy.close(); store.closeDb(); await rm(dir, { recursive: true, force: true }); });
  store.upsertApp(manifest());
  const task = store.createTask('owner', 'limits', 'run', {}).task;
  store.close(task.task_id, 'owner', 'retry');
  const schedule = store.createSchedule('limits', 'run', {}, '* * * * *', 'UTC');
  const oversized = JSON.stringify({ text: 'x'.repeat(65536) });
  legacy.prepare('UPDATE tasks SET input_json = ? WHERE id = ?').run(oversized, task.task_id);
  legacy.prepare('UPDATE schedules SET input_json = ? WHERE id = ?').run(oversized, schedule.schedule_id);
  assert.throws(() => store.retry(task.task_id, 'owner'),
    (error: unknown) => (error as { code: string }).code === 'INPUT_TOO_LARGE');
  assert.equal(store.runScheduleNow(schedule.schedule_id).skipped, 'failed');
  assert.match(store.listScheduleRuns(schedule.schedule_id)[0].reason!, /INPUT_TOO_LARGE/);
  assert.equal(store.schedulerTick(Date.parse(schedule.next_fire_at!)), 0);
  assert.equal(store.listTasks().tasks.length, 1);
  assert.equal(store.listScheduleRuns(schedule.schedule_id).length, 2);
});

test('HTTP：任务/调度输入执行 64 KiB 限制，较大检查点与结果仍可提交', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-http-input-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const server = createPlatformServer(store, { artifactDir: join(dir, 'artifacts'), requestLog: () => {} });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeDb(); await rm(dir, { recursive: true, force: true });
  });
  store.bootstrap('owner', 'test-password-123456');
  const token = store.login('owner', 'test-password-123456');
  const workerToken = store.upsertApp(manifest()).worker_token!;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, worker = false) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${worker ? workerToken : token}`,
      ...(worker ? { 'x-attempt-id': lease.attempt_id } : {}) }, body: JSON.stringify(body),
  });
  const oversized = { text: '中'.repeat(23000) };
  for (const [path, body] of [
    ['/v1/tasks', { task: 'limits/run', input: oversized }],
    ['/v1/schedules', { app_id: 'limits', task_key: 'run', input: oversized, cron: '* * * * *', timezone: 'UTC' }],
  ] as const) {
    const response = await post(path, body);
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'INPUT_TOO_LARGE');
  }
  assert.equal(store.listTasks().tasks.length, 0);
  assert.equal(store.listSchedules().length, 0);
  const task = store.createTask('owner', 'limits', 'run', {}).task;
  const lease = store.lease('limits')!;
  const checkpoint = await post(`/v1/worker/tasks/${task.task_id}/steps`, { step_key: 'large', value: oversized }, true);
  assert.equal(checkpoint.status, 200); await checkpoint.arrayBuffer();
  const completed = await post(`/v1/worker/tasks/${task.task_id}/complete`, { output: oversized }, true);
  assert.equal(completed.status, 200); await completed.arrayBuffer();
});
