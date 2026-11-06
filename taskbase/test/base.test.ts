import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatformServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { nextFire, parseCron } from '../src/cron.ts';

const PASSWORD = 'a-long-test-password';

type Manifest = Record<string, unknown>;

function echoManifest(overrides: {
  appId?: string; maxConcurrency?: number; queueTimeoutMs?: number; executionTimeoutMs?: number;
  maxAttempts?: number; schedulable?: boolean;
} = {}): Manifest {
  return {
    app_id: overrides.appId ?? 'demo',
    display_name: overrides.appId ?? 'Demo',
    max_concurrency: overrides.maxConcurrency ?? 2,
    tasks: [{
      task_key: 'echo',
      display_name: 'Echo',
      input_schema: {
        type: 'object', required: ['text'], additionalProperties: false,
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 1000 },
          artifact: { type: 'boolean' },
        },
      },
      output_schema: {
        type: 'object', required: ['echo'], additionalProperties: false,
        properties: {
          echo: { type: 'string', minLength: 1 },
          artifact_id: { type: 'string', minLength: 1 },
        },
      },
      queue_timeout_ms: overrides.queueTimeoutMs ?? 3_600_000,
      execution_timeout_ms: overrides.executionTimeoutMs ?? 3_600_000,
      max_attempts: overrides.maxAttempts ?? 3,
      artifact_policy: { required: false, max_bytes: 1024 * 1024 },
      schedulable: overrides.schedulable ?? false,
    }],
  };
}

type Harness = {
  base: string;
  store: Store;
  ownerToken: string;
  artifactDir: string;
  close: () => Promise<void>;
  api: (method: string, path: string, options?: {
    token?: string | null; body?: unknown; headers?: Record<string, string>;
  }) => Promise<{ status: number; data: any }>;
  raw: (method: string, path: string, options?: {
    token?: string | null; body?: Buffer | string; headers?: Record<string, string>;
  }) => Promise<Response>;
};

async function harness(options: { leaseMs?: number } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-'));
  const store = new Store(join(directory, 'taskbase.sqlite'), { leaseMs: options.leaseMs ?? 60_000 });
  store.bootstrap('owner', PASSWORD);
  const artifactDir = join(directory, 'artifacts');
  const server = createPlatformServer(store, {
    artifactDir,
    leaseMs: options.leaseMs ?? 60_000,
    sweepMs: 1_000_000,
    schedulerMs: 1_000_000,
    maxArtifactBytes: 1024 * 1024,
    requestLog: () => {},
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function api(method: string, path: string,
    requestOptions: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = {
      ...(requestOptions.token ? { authorization: `Bearer ${requestOptions.token}` } : {}),
      ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...requestOptions.headers,
    };
    const response = await fetch(new URL(path, base), {
      method,
      headers,
      ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) as unknown : null; } catch { data = text; }
    return { status: response.status, data };
  }

  async function raw(method: string, path: string,
    requestOptions: { token?: string | null; body?: Buffer | string; headers?: Record<string, string> } = {}) {
    return fetch(new URL(path, base), {
      method,
      headers: {
        ...(requestOptions.token ? { authorization: `Bearer ${requestOptions.token}` } : {}),
        ...requestOptions.headers,
      },
      ...(requestOptions.body === undefined ? {} : {
        body: typeof requestOptions.body === 'string'
          ? requestOptions.body
          : new Uint8Array(requestOptions.body),
      }),
    });
  }

  const login = await api('POST', '/v1/auth/login', { body: { username: 'owner', password: PASSWORD } });
  assert.equal(login.status, 200);
  const ownerToken = (login.data as { token: string }).token;

  return {
    base, store, ownerToken, artifactDir, api, raw,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      store.closeDb();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function register(h: Harness, manifest: Manifest): Promise<string> {
  const result = await h.api('POST', '/v1/apps', { token: h.ownerToken, body: manifest });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(typeof result.data.worker_token, 'string');
  return result.data.worker_token as string;
}

async function submit(h: Harness, task: string, input: unknown,
  idempotencyKey?: string): Promise<{ status: number; taskId: string; data: any }> {
  const result = await h.api('POST', '/v1/tasks', {
    token: h.ownerToken,
    body: { task, input },
    ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
  });
  return {
    status: result.status,
    taskId: (result.data as { task: { task_id: string } }).task.task_id,
    data: result.data,
  };
}

async function lease(h: Harness, workerToken: string): Promise<{ status: number; data: any }> {
  return h.api('POST', '/v1/worker/leases', { token: workerToken });
}

test('任务闭环：注册、领取、进度、检查点、产物、完成', async (t) => {
  const h = await harness();
  t.after(h.close);
  const workerToken = await register(h, echoManifest());

  const created = await submit(h, 'demo/echo', { text: 'hello', artifact: true });
  assert.equal(created.status, 202);

  const leased = await lease(h, workerToken);
  assert.equal(leased.status, 200);
  const taskId = leased.data.task_id as string;
  const attemptId = leased.data.attempt_id as string;
  assert.equal(taskId, created.taskId);
  assert.deepEqual(leased.data.input, { text: 'hello', artifact: true });

  const workerHeaders = { 'x-attempt-id': attemptId };
  assert.equal((await h.api('POST', `/v1/worker/tasks/${taskId}/heartbeat`,
    { token: workerToken, headers: workerHeaders })).status, 200);
  assert.equal((await h.api('POST', `/v1/worker/tasks/${taskId}/progress`,
    { token: workerToken, headers: workerHeaders, body: { progress: 40, message: '半程' } })).status, 200);
  assert.equal((await h.api('POST', `/v1/worker/tasks/${taskId}/steps`,
    { token: workerToken, headers: workerHeaders, body: { step_key: 'prepare', value: { text: 'hello' } } })).status, 200);

  const upload = await h.raw('PUT', `/v1/worker/tasks/${taskId}/artifacts?name=echo.txt`, {
    token: workerToken,
    headers: { ...workerHeaders, 'content-type': 'text/plain' },
    body: Buffer.from('echo: hello\n', 'utf8'),
  });
  assert.equal(upload.status, 201);
  const artifact = await upload.json() as { artifact_id: string };

  const completed = await h.api('POST', `/v1/worker/tasks/${taskId}/complete`, {
    token: workerToken,
    headers: workerHeaders,
    body: { output: { echo: 'echo: hello', artifact_id: artifact.artifact_id } },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.data));

  const result = await h.api('GET', `/v1/tasks/${taskId}/result`, { token: h.ownerToken });
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'succeeded');
  assert.equal(result.data.artifact_id, artifact.artifact_id);

  const downloaded = await h.raw('GET', `/v1/artifacts/${artifact.artifact_id}/download`, { token: h.ownerToken });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'echo: hello\n');

  const events = await h.api('GET', `/v1/tasks/${taskId}/events`, { token: h.ownerToken });
  assert.ok(events.data.events.some((event: { type: string }) => event.type === 'status'));
});

test('幂等、认证隔离与应用隔离', async (t) => {
  const h = await harness();
  t.after(h.close);
  const demoToken = await register(h, echoManifest({ appId: 'demo' }));
  await register(h, echoManifest({ appId: 'other' }));

  const first = await submit(h, 'demo/echo', { text: 'same' }, 'key-1');
  const second = await submit(h, 'demo/echo', { text: 'same' }, 'key-1');
  assert.equal(second.status, 200);
  assert.equal(second.taskId, first.taskId);
  const conflict = await h.api('POST', '/v1/tasks', {
    token: h.ownerToken,
    body: { task: 'demo/echo', input: { text: 'different' } },
    headers: { 'idempotency-key': 'key-1' },
  });
  assert.equal(conflict.status, 409);

  assert.equal((await h.api('GET', '/v1/apps', { token: demoToken })).status, 401);
  assert.equal((await h.api('POST', '/v1/worker/leases', { token: h.ownerToken })).status, 401);

  const leased = await lease(h, demoToken);
  assert.equal(leased.status, 200);
  assert.equal(leased.data.app_id, 'demo');
  assert.equal((await lease(h, demoToken)).status, 204, 'demo 应用并发上限为 2，但任务已领取且没有第二个任务');
});

test('租约恢复、旧尝试隔离与重试', async (t) => {
  const h = await harness({ leaseMs: 50 });
  t.after(h.close);
  const workerToken = await register(h, echoManifest({ appId: 'recover', maxAttempts: 2 }));
  const created = await submit(h, 'recover/echo', { text: 'recover' });
  const first = await lease(h, workerToken);
  assert.equal(first.status, 200);
  const firstTaskId = first.data.task_id as string;
  const firstAttemptId = first.data.attempt_id as string;

  await new Promise((done) => setTimeout(done, 90));
  h.store.sweep();
  const recovering = await h.api('GET', `/v1/tasks/${firstTaskId}`, { token: h.ownerToken });
  assert.equal(recovering.data.status, 'recovering');
  assert.equal((await h.api('POST', `/v1/worker/tasks/${firstTaskId}/heartbeat`, {
    token: workerToken, headers: { 'x-attempt-id': firstAttemptId },
  })).status, 409);

  const second = await lease(h, workerToken);
  assert.equal(second.status, 200);
  const secondAttemptId = second.data.attempt_id as string;
  const completed = await h.api('POST', `/v1/worker/tasks/${firstTaskId}/complete`, {
    token: workerToken,
    headers: { 'x-attempt-id': secondAttemptId },
    body: { output: { echo: 'recovered' } },
  });
  assert.equal(completed.status, 200);
  assert.equal((await h.api('GET', `/v1/tasks/${firstTaskId}`, { token: h.ownerToken })).data.status, 'succeeded');

  const failing = await submit(h, 'recover/echo', { text: 'will fail' });
  const failingLease = await lease(h, workerToken);
  assert.equal(failingLease.status, 200);
  await h.api('POST', `/v1/worker/tasks/${failingLease.data.task_id}/fail`, {
    token: workerToken,
    headers: { 'x-attempt-id': failingLease.data.attempt_id },
    body: { message: '业务失败' },
  });
  const retry = await h.api('POST', `/v1/tasks/${failing.taskId}/retry`, { token: h.ownerToken });
  assert.equal(retry.status, 202);
  assert.equal(retry.data.retry_of_task_id, failing.taskId);
});

test('手动关闭后拒绝迟到结果，重试创建新任务', async (t) => {
  const h = await harness();
  t.after(h.close);
  const workerToken = await register(h, echoManifest({ appId: 'close', maxConcurrency: 1 }));
  const created = await submit(h, 'close/echo', { text: 'close' });
  const leased = await lease(h, workerToken);
  assert.equal(leased.status, 200);
  const taskId = leased.data.task_id as string;
  const attemptId = leased.data.attempt_id as string;

  const closed = await h.api('POST', `/v1/tasks/${taskId}/close`, {
    token: h.ownerToken, body: { reason: '手动终止' },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.status, 'closed');
  assert.equal(closed.data.close_reason, '手动终止');

  const late = await h.api('POST', `/v1/worker/tasks/${taskId}/complete`, {
    token: workerToken, headers: { 'x-attempt-id': attemptId }, body: { output: { echo: 'late' } },
  });
  assert.equal(late.status, 409);

  const retry = await h.api('POST', `/v1/tasks/${taskId}/retry`, { token: h.ownerToken });
  assert.equal(retry.status, 202);
  assert.equal(retry.data.retry_of_task_id, taskId);
  assert.equal(retry.data.status, 'queued');
  assert.equal(created.status, 202);
});

test('排队超时与执行超时进入 closed', async (t) => {
  const h = await harness({ leaseMs: 1_000 });
  t.after(h.close);
  const queueToken = await register(h, echoManifest({ appId: 'queue-timeout', queueTimeoutMs: 1_000 }));
  const queued = await submit(h, 'queue-timeout/echo', { text: 'queue' });
  h.store.sweep(Date.now() + 2_000);
  const queuedTask = await h.api('GET', `/v1/tasks/${queued.taskId}`, { token: h.ownerToken });
  assert.equal(queuedTask.data.status, 'closed');
  assert.equal(queuedTask.data.close_reason, 'QUEUE_TIMEOUT');

  const executionToken = await register(h, echoManifest({ appId: 'exec-timeout', executionTimeoutMs: 1_000 }));
  const executing = await submit(h, 'exec-timeout/echo', { text: 'exec' });
  assert.equal((await lease(h, executionToken)).status, 200);
  h.store.sweep(Date.now() + 2_000);
  const executionTask = await h.api('GET', `/v1/tasks/${executing.taskId}`, { token: h.ownerToken });
  assert.equal(executionTask.data.status, 'closed');
  assert.equal(executionTask.data.close_reason, 'TIMEOUT');
  assert.equal((await lease(h, queueToken)).status, 204);
});

test('任务定义覆盖更新与输入 schema 校验', async (t) => {
  const h = await harness();
  t.after(h.close);
  await register(h, echoManifest({ appId: 'update' }));
  const first = await h.api('GET', '/v1/apps/update/tasks', { token: h.ownerToken });
  assert.equal(first.data.tasks[0].display_name, 'Echo');

  const updated = echoManifest({ appId: 'update' });
  (updated.tasks as any[])[0].display_name = 'Echo V2';
  (updated.tasks as any[])[0].input_schema = {
    type: 'object', required: ['text', 'extra'], additionalProperties: false,
    properties: {
      text: { type: 'string', minLength: 1 },
      extra: { type: 'string', minLength: 1 },
    },
  };
  const registered = await h.api('POST', '/v1/apps', { token: h.ownerToken, body: updated });
  assert.equal(registered.status, 200);
  const second = await h.api('GET', '/v1/apps/update/tasks', { token: h.ownerToken });
  assert.equal(second.data.tasks[0].display_name, 'Echo V2');

  const invalid = await h.api('POST', '/v1/tasks', {
    token: h.ownerToken, body: { task: 'update/echo', input: { text: 'x' } },
  });
  assert.equal(invalid.status, 400);
  const valid = await h.api('POST', '/v1/tasks', {
    token: h.ownerToken, body: { task: 'update/echo', input: { text: 'x', extra: 'y' } },
  });
  assert.equal(valid.status, 202);
});

test('健康检查与登录失败', async (t) => {
  const h = await harness();
  t.after(h.close);
  assert.equal((await h.api('GET', '/health')).status, 200);
  const bad = await h.api('POST', '/v1/auth/login', { body: { username: 'owner', password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  assert.equal((await h.api('GET', '/v1/tasks', { token: null })).status, 401);
});


test('cron 解析与下次触发', () => {
  assert.equal(nextFire('* * * * *', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0)),
    Date.UTC(2026, 0, 1, 0, 1, 0));
  const weekly = nextFire('0 9 * * 1', 'Asia/Shanghai', Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(new Date(weekly as number).toISOString(), '2026-01-05T01:00:00.000Z');
  assert.equal(new Date(nextFire('0 9 * * 1', 'Asia/Shanghai', weekly as number) as number).toISOString(),
    '2026-01-12T01:00:00.000Z');
  const sunday = nextFire('0 9 * * 7', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(new Date(sunday as number).toISOString(), '2026-01-04T09:00:00.000Z');
  assert.throws(() => parseCron('bad'));
  assert.throws(() => nextFire('* * * * *', 'Not/AZone', 0));
});

test('调度：创建、触发、重叠跳过、run-now、停用与删除', async (t) => {
  const h = await harness();
  t.after(h.close);
  await register(h, echoManifest({ appId: 'scheduled', schedulable: true }));

  const created = await h.api('POST', '/v1/schedules', {
    token: h.ownerToken,
    body: {
      app_id: 'scheduled', task_key: 'echo', input: { text: 'scheduled' },
      cron: '* * * * *', timezone: 'UTC',
    },
  });
  assert.equal(created.status, 201);
  const schedule = created.data.schedule;
  const scheduleId = schedule.schedule_id as string;
  assert.equal(schedule.enabled, true);
  assert.ok(schedule.next_fire_at);

  const planned = Date.parse(schedule.next_fire_at);
  assert.equal(h.store.schedulerTick(planned + 1_000), 1);

  const list = await h.api('GET', `/v1/tasks?schedule_id=${scheduleId}`, { token: h.ownerToken });
  assert.equal(list.data.tasks.length, 1);
  const task = list.data.tasks[0];
  assert.equal(task.source, 'schedule');
  assert.equal(task.schedule_id, scheduleId);

  const afterFirst = await h.api('GET', `/v1/schedules/${scheduleId}`, { token: h.ownerToken });
  const nextPlanned = Date.parse(afterFirst.data.next_fire_at);
  assert.equal(h.store.schedulerTick(nextPlanned + 1_000), 0);
  const runs = await h.api('GET', `/v1/schedules/${scheduleId}/runs`, { token: h.ownerToken });
  assert.ok(runs.data.runs.some((run: { status: string }) => run.status === 'skipped_overlap'));

  const skippedRunNow = await h.api('POST', `/v1/schedules/${scheduleId}/run-now`, { token: h.ownerToken });
  assert.equal(skippedRunNow.status, 200);
  assert.equal(skippedRunNow.data.skipped, 'overlap');

  await h.api('POST', `/v1/tasks/${task.task_id}/close`, { token: h.ownerToken, body: { reason: '测试' } });
  const runNow = await h.api('POST', `/v1/schedules/${scheduleId}/run-now`, { token: h.ownerToken });
  assert.equal(runNow.status, 200);
  assert.equal(runNow.data.task.status, 'queued');
  assert.equal(runNow.data.task.schedule_id, scheduleId);

  const disabled = await h.api('PATCH', `/v1/schedules/${scheduleId}`, {
    token: h.ownerToken, body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.schedule.enabled, false);
  assert.equal(disabled.data.schedule.next_fire_at, null);
  assert.equal(h.store.schedulerTick(Date.now() + 3_600_000), 0);

  assert.equal((await h.api('DELETE', `/v1/schedules/${scheduleId}`, { token: h.ownerToken })).status, 200);
  assert.equal((await h.api('GET', `/v1/schedules/${scheduleId}`, { token: h.ownerToken })).status, 404);
});
