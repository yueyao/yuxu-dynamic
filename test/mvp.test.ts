/** 进程内 HTTP 集成测试：覆盖登录、CLI、Worker、恢复、持久化及文件下载。 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createApiServer } from '../apps/platform-api/src/server.ts';
import { executeLease, runOnce } from '../apps/example-app/src/worker.ts';
import { main as cliMain, taskInput } from '../apps/cli/src/main.ts';
import { Store } from '../packages/core/src/store.ts';
import { PlatformClient } from '../packages/client-sdk/src/index.ts';
import { WorkerClient } from '../packages/worker-sdk/src/index.ts';

type Harness = {
  baseUrl: string;
  ownerToken: string;
  workerToken: string;
  fetchImpl: typeof fetch;
  store: Store;
  dbPath: string;
  close: () => Promise<void>;
};

async function harness(leaseMs = 60_000): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'platform-mvp-'));
  const dbPath = join(dir, 'platform.sqlite');
  const store = new Store(dbPath);
  const workerToken = store.bootstrap('owner', 'a-long-test-password');
  const ownerToken = store.login('owner', 'a-long-test-password');
  const server = createApiServer(store, { artifactDir: join(dir, 'artifacts'), leaseMs, sweepMs: 20,
    requestLog: () => {} });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? Buffer.from(init.body as string | Uint8Array) : Buffer.alloc(0);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (body.length > 0) headers['content-length'] = String(body.length);
    const request = new PassThrough();
    Object.assign(request, {
      url: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      headers,
      socket: { remoteAddress: 'in-process-test' },
    });
    const response = new LocalResponse();
    const finished = once(response, 'finish');
    request.end(body);
    server.emit('request', request as unknown as IncomingMessage, response as unknown as ServerResponse);
    await finished;
    return new Response(response.status === 204 ? null : Buffer.concat(response.chunks), {
      status: response.status,
      headers: response.headers,
    });
  };
  return {
    baseUrl: 'http://platform.local',
    ownerToken, workerToken, fetchImpl, store, dbPath,
    close: async () => {
      server.emit('close');
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

class LocalResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  headersSent = false;

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
    this.headersSent = true;
    return this;
  }

  end(data?: string | Buffer): void {
    if (data) this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    this.emit('finish');
  }

  destroy(): void { this.emit('finish'); }
}

async function request(h: Harness, token: string | null, path: string, init: RequestInit = {}) {
  const response = await h.fetchImpl(new URL(path, h.baseUrl), {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const data = response.status === 204 ? null : await response.json() as Record<string, unknown>;
  return { response, data };
}

test('登录、幂等提交、Worker 执行和产物下载构成闭环', async (t) => {
  const h = await harness();
  t.after(h.close);
  const unauthorized = await request(h, null, '/v1/apps');
  assert.equal(unauthorized.response.status, 401);
  const login = await request(h, null, '/v1/auth/cli-token', {
    method: 'POST', body: JSON.stringify({ username: 'owner', password: 'a-long-test-password' }),
  });
  assert.equal(login.response.status, 200);
  h.ownerToken = login.data?.token as string;

  const body = { task: 'example-app/report/build', input: { title: 'MVP 验收' } };
  const first = await request(h, h.ownerToken, '/v1/tasks', {
    method: 'POST', headers: { 'idempotency-key': 'same-request' }, body: JSON.stringify(body),
  });
  assert.equal(first.response.status, 202);
  const taskId = (first.data?.task as { task_id: string }).task_id;
  const duplicate = await request(h, h.ownerToken, '/v1/tasks', {
    method: 'POST', headers: { 'idempotency-key': 'same-request' }, body: JSON.stringify(body),
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal((duplicate.data?.task as { task_id: string }).task_id, taskId);
  const conflict = await request(h, h.ownerToken, '/v1/tasks', {
    method: 'POST', headers: { 'idempotency-key': 'same-request' },
    body: JSON.stringify({ ...body, input: { title: '不同输入' } }),
  });
  assert.equal(conflict.response.status, 409);

  assert.equal(await runOnce({ baseUrl: h.baseUrl, token: h.workerToken, fetchImpl: h.fetchImpl, delayMs: 5, heartbeatMs: 20 }), true);
  const task = await request(h, h.ownerToken, `/v1/tasks/${taskId}`);
  assert.equal(task.data?.status, 'succeeded');
  assert.equal(task.data?.progress, 100);
  const artifactId = task.data?.artifact_id as string;
  assert.ok(artifactId);
  const download = await h.fetchImpl(new URL(`/v1/artifacts/${artifactId}/download`, h.baseUrl), {
    headers: { authorization: `Bearer ${h.ownerToken}` },
  });
  assert.equal(download.status, 200);
  assert.match(await download.text(), /MVP 验收/);
  const privateDownload = await h.fetchImpl(new URL(`/v1/artifacts/${artifactId}/download`, h.baseUrl));
  assert.equal(privateDownload.status, 401);
  const events = await request(h, h.ownerToken, `/v1/tasks/${taskId}/events?after=0`);
  assert.ok((events.data?.events as Array<{ type: string }>).some((event) => event.type === 'step'));
  assert.ok((events.data?.events as Array<{ payload: { status?: string } }>).some(
    (event) => event.payload.status === 'succeeded'));
});

test('租约恢复与迟到尝试隔离', async (t) => {
  const h = await harness(80);
  t.after(h.close);
  const submitted = await request(h, h.ownerToken, '/v1/tasks', {
    method: 'POST', body: JSON.stringify({ task: 'example-app/report/build', input: { title: '恢复测试' } }),
  });
  const taskId = (submitted.data?.task as { task_id: string }).task_id;
  const [first, second] = await Promise.all([
    request(h, h.workerToken, '/v1/worker/leases', { method: 'POST' }),
    request(h, h.workerToken, '/v1/worker/leases', { method: 'POST' }),
  ]);
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 204]);
  const lease = (first.response.status === 200 ? first.data : second.data) as {
    task_id: string; attempt_id: string; app_id: string; task_key: string; release_digest: string;
    input: unknown; steps: Record<string, unknown>;
  };
  await request(h, h.workerToken, `/v1/worker/tasks/${taskId}/steps`, {
    method: 'POST', headers: { 'x-attempt-id': lease.attempt_id },
    body: JSON.stringify({ step_key: 'prepare', value: { title: '恢复测试' } }),
  });
  await new Promise((done) => setTimeout(done, 100));
  h.store.recoverExpired();
  assert.equal(h.store.getTask(taskId).status, 'recovering');
  const next = await request(h, h.workerToken, '/v1/worker/leases', { method: 'POST' });
  assert.equal(next.response.status, 200);
  const newLease = next.data as typeof lease;
  assert.notEqual(newLease.attempt_id, lease.attempt_id);
  assert.deepEqual(newLease.steps.prepare, { title: '恢复测试' });

  const late = await request(h, h.workerToken, `/v1/worker/tasks/${taskId}/progress`, {
    method: 'POST', headers: { 'x-attempt-id': lease.attempt_id },
    body: JSON.stringify({ progress: 99, message: '迟到' }),
  });
  assert.equal(late.response.status, 409);
  await executeLease({ baseUrl: h.baseUrl, token: h.workerToken, fetchImpl: h.fetchImpl, delayMs: 5, heartbeatMs: 20 }, newLease);
  assert.equal(h.store.getTask(taskId).status, 'succeeded');
  assert.equal(h.store.getTask(taskId).attempt_count, 2);
});

test('任务状态在数据库重新打开后保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-persist-'));
  const path = join(dir, 'platform.sqlite');
  try {
    let store = new Store(path);
    store.bootstrap('owner', 'a-long-test-password');
    const result = store.createTask('user:owner', 'example-app', 'report/build', { title: '持久化' }, null);
    const id = result.task.task_id;
    store.close();
    store = new Store(path);
    assert.equal(store.getTask(id).status, 'queued');
    assert.equal(store.getEvents(id).length, 1);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('排队任务超过总时限后失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-deadline-'));
  const store = new Store(join(dir, 'platform.sqlite'));
  try {
    store.bootstrap('owner', 'a-long-test-password');
    const task = store.createTask('user:owner', 'example-app', 'report/build', { title: '超时' }, null).task;
    assert.equal(store.recoverExpired(Date.now() + 2 * 60 * 60 * 1000), 1);
    assert.equal(store.getTask(task.task_id).status, 'failed');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI 可以提交、追踪和下载任务结果', async (t) => {
  const h = await harness();
  t.after(h.close);
  const inputPath = join(dirname(h.dbPath), 'input.json');
  const outputPath = join(dirname(h.dbPath), 'report.txt');
  await writeFile(inputPath, JSON.stringify({ title: 'CLI 验收' }));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalToken = process.env.PLATFORM_TOKEN;
  const logs: string[] = [];
  globalThis.fetch = h.fetchImpl;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  process.env.PLATFORM_TOKEN = h.ownerToken;
  try {
    await cliMain(['task', 'run', 'example-app/report/build', '--input', inputPath]);
    const submitted = JSON.parse(logs[0]) as { task: { task_id: string } };
    const taskId = submitted.task.task_id;
    assert.equal(await runOnce({ baseUrl: h.baseUrl, token: h.workerToken, fetchImpl: h.fetchImpl, delayMs: 5 }), true);
    await cliMain(['task', 'watch', taskId]);
    await cliMain(['task', 'result', taskId]);
    await cliMain(['task', 'logs', taskId]);
    await cliMain(['tasks', 'history', '--app', 'example-app', '--status', 'succeeded', '--limit', '1']);
    const artifactId = h.store.getTask(taskId).artifact_id;
    assert.ok(artifactId);
    await cliMain(['artifact', 'download', artifactId, '--out', outputPath]);
    assert.match(await readFile(outputPath, 'utf8'), /CLI 验收/);
    assert.ok(logs.some((line) => line.includes('任务状态: succeeded')));
    assert.ok(logs.some((line) => line.includes('开始处理报告任务')));
    assert.ok(logs.some((line) => line.includes('next_cursor')));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalToken === undefined) delete process.env.PLATFORM_TOKEN;
    else process.env.PLATFORM_TOKEN = originalToken;
  }
});

test('个人 CLI 绑定服务器凭据，并可内联提交后等待结果', async (t) => {
  const h = await harness();
  t.after(h.close);
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const variables = ['YUXU_CLI_DIR', 'PLATFORM_CLI_DIR', 'PLATFORM_URL', 'PLATFORM_TOKEN', 'PLATFORM_PASSWORD'] as const;
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  const previousExitCode = process.exitCode;
  const lines: string[] = [];
  globalThis.fetch = h.fetchImpl;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  process.env.YUXU_CLI_DIR = join(dirname(h.dbPath), 'personal-cli');
  process.env.PLATFORM_PASSWORD = 'a-long-test-password';
  delete process.env.PLATFORM_URL;
  delete process.env.PLATFORM_TOKEN;
  try {
    await assert.rejects(cliMain(['config', 'set-server', 'http://example.com']), /HTTPS/);
    await cliMain(['config', 'set-server', 'http://127.0.0.1:3333']);
    await cliMain(['login']);
    const { createHash } = await import('node:crypto');
    const credentialKey = createHash('sha256').update('http://127.0.0.1:3333').digest('hex');
    const credentialPath = join(process.env.YUXU_CLI_DIR, 'credentials', `${credentialKey}.json`);
    const saved = JSON.parse(await readFile(credentialPath, 'utf8')) as { server: string; token: string };
    assert.equal(saved.server, 'http://127.0.0.1:3333');
    assert.ok(saved.token.length > 0);
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    assert.equal((await stat(process.env.YUXU_CLI_DIR)).mode & 0o777, 0o700);
    await cliMain(['apps', 'list']);
    await cliMain(['config', 'set-server', 'http://127.0.0.1:4444']);
    await assert.rejects(cliMain(['apps', 'list']), /尚未登录/);
    await cliMain(['apps', 'list', '--server', 'http://127.0.0.1:3333']);
    await cliMain(['config', 'set-server', 'http://127.0.0.1:3333']);
    await assert.rejects(cliMain(['apps', 'list', '--typo']), /未知选项/);
    await cliMain(['config', 'set-server', 'http://127.0.0.1:3333']);

    const worker = (async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await runOnce({ baseUrl: h.baseUrl, token: h.workerToken,
          fetchImpl: h.fetchImpl, delayMs: 5 })) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error('Worker 未领取到 CLI 提交的任务');
    })();
    await cliMain(['task', 'run', 'example-app/report/build', '--input-json', '{"title":"个人 CLI"}',
      '--wait', '--timeout', '5']);
    await worker;
    assert.ok(lines.some((line) => line.includes('任务状态: succeeded')));
    assert.equal(h.store.listTasks({ status: 'succeeded' }).tasks.length, 1);

    await assert.rejects(cliMain(['task', 'run', 'example-app/report/build',
      '--input-json', '{"title":"超时任务"}', '--run-at', new Date(Date.now() + 30_000).toISOString(),
      '--wait', '--timeout', '1']), /等待任务 .* 超时/);
    assert.equal(h.store.listTasks({ status: 'queued' }).tasks.length, 1);

    const failed = h.store.createTask('user:test', 'example-app', 'report/build',
      { title: '失败退出码' }, null).task;
    const failedLease = await new WorkerClient({ baseUrl: h.baseUrl, token: h.workerToken,
      fetchImpl: h.fetchImpl }).lease();
    assert.ok(failedLease);
    assert.equal(failedLease.task_id, failed.task_id);
    await new WorkerClient({ baseUrl: h.baseUrl, token: h.workerToken,
      fetchImpl: h.fetchImpl }).fail(failedLease, '预期失败');
    await cliMain(['task', 'watch', failed.task_id]);
    assert.equal(process.exitCode, 1);
    await cliMain(['logout']);
    await assert.rejects(cliMain(['apps', 'list']), /尚未登录/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    process.exitCode = previousExitCode;
  }
});

test('CLI 任务输入支持文件、内联 JSON 和标准输入，并在请求前拒绝过大内容', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-cli-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'input.json');
  await writeFile(path, '{"title":"文件输入"}');
  assert.deepEqual(await taskInput(['--input', path]), { title: '文件输入' });
  assert.deepEqual(await taskInput(['--input-json', '{"title":"内联输入"}']), { title: '内联输入' });
  const piped = (async function* () { yield Buffer.from('{"title":"管道输入"}'); })();
  assert.deepEqual(await taskInput(['--input', '-'], piped), { title: '管道输入' });
  await assert.rejects(taskInput(['--input-json', `"${'x'.repeat(60 * 1024)}"`]), /超过 60 KiB/);
  await assert.rejects(taskInput(['--input', path, '--input-json', '{}']), /只能选择一个/);
  await assert.rejects(taskInput(['--input-json', '{broken']), /不是有效的 JSON/);
});

test('CLI 重命名后按需迁移旧 platform-cli 配置和服务器凭据', async (t) => {
  const h = await harness();
  t.after(h.close);
  const configHome = join(dirname(h.dbPath), 'config-home');
  const legacyDir = join(configHome, 'platform-cli');
  const newDir = join(configHome, 'yuxu');
  const { createHash } = await import('node:crypto');
  const server = 'http://127.0.0.1:3333';
  const key = createHash('sha256').update(server).digest('hex');
  await mkdir(join(legacyDir, 'credentials'), { recursive: true, mode: 0o700 });
  await writeFile(join(legacyDir, 'config.json'), JSON.stringify({ server }));
  const legacyToken = h.store.login('owner', 'a-long-test-password');
  await writeFile(join(legacyDir, 'credentials', `${key}.json`),
    JSON.stringify({ server, token: legacyToken }), { mode: 0o600 });

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const names = ['XDG_CONFIG_HOME', 'YUXU_CLI_DIR', 'PLATFORM_CLI_DIR', 'PLATFORM_URL', 'PLATFORM_TOKEN'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  globalThis.fetch = h.fetchImpl;
  console.log = () => {};
  process.env.XDG_CONFIG_HOME = configHome;
  for (const name of names.slice(1)) delete process.env[name];
  try {
    await cliMain(['apps', 'list']);
    assert.equal((JSON.parse(await readFile(join(newDir, 'config.json'), 'utf8')) as { server: string }).server, server);
    assert.equal((JSON.parse(await readFile(join(newDir, 'credentials', `${key}.json`), 'utf8')) as { token: string }).token, legacyToken);
    await assert.rejects(readFile(join(legacyDir, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(legacyDir, 'credentials', `${key}.json`)), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('平台请求中断不会被记录为业务失败', async (t) => {
  const h = await harness(80);
  t.after(h.close);
  const submitted = await request(h, h.ownerToken, '/v1/tasks', {
    method: 'POST', body: JSON.stringify({ task: 'example-app/report/build', input: { title: '断线恢复' } }),
  });
  const taskId = (submitted.data?.task as { task_id: string }).task_id;
  const interruptedFetch: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/progress')) throw new TypeError('模拟连接中断');
    return h.fetchImpl(input, init);
  };
  await assert.rejects(runOnce({ baseUrl: h.baseUrl, token: h.workerToken,
    fetchImpl: interruptedFetch, delayMs: 5, heartbeatMs: 20 }), /模拟连接中断/);
  assert.equal(h.store.getTask(taskId).status, 'running');
  await new Promise((done) => setTimeout(done, 100));
  h.store.recoverExpired();
  assert.equal(h.store.getTask(taskId).status, 'recovering');
});

test('一次性计划任务到点后才领取，结果接口支持轮询和幂等重试', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = new PlatformClient({ baseUrl: h.baseUrl, token: h.ownerToken, fetchImpl: h.fetchImpl });
  const runAt = new Date(Date.now() + 120).toISOString();
  const first = await client.submitTask('example-app/report/build', { title: '计划执行' },
    { runAt, idempotencyKey: 'scheduled-once' });
  const id = first.task.task_id;
  assert.equal(first.task.scheduled_at, runAt);
  assert.equal(Date.parse(first.task.deadline_at) - Date.parse(runAt), 60 * 60 * 1000);
  assert.equal((await client.getResult(id)).status, 'queued');
  assert.equal((await request(h, h.ownerToken, `/v1/tasks/${id}/result`)).response.status, 202);
  assert.equal((await request(h, h.workerToken, '/v1/worker/leases', { method: 'POST' })).response.status, 204);
  await new Promise((done) => setTimeout(done, 140));
  assert.equal(await runOnce({ baseUrl: h.baseUrl, token: h.workerToken, fetchImpl: h.fetchImpl, delayMs: 5 }), true);
  assert.equal((await client.getResult(id)).status, 'succeeded');
  assert.equal((await request(h, h.ownerToken, `/v1/tasks/${id}/result`)).response.status, 200);
  // 计划时间已过后，网络重试仍应得到同一个任务。
  const duplicate = await client.submitTask('example-app/report/build', { title: '计划执行' },
    { runAt, idempotencyKey: 'scheduled-once' });
  assert.equal(duplicate.task.task_id, id);
  assert.equal(duplicate.reused, true);
  const changed = await request(h, h.ownerToken, '/v1/tasks', { method: 'POST',
    headers: { 'idempotency-key': 'scheduled-once' }, body: JSON.stringify({
      task: 'example-app/report/build', input: { title: '计划执行' },
      run_at: new Date(Date.now() + 60_000).toISOString(),
    }) });
  assert.equal(changed.response.status, 409);
  const invalid = await request(h, h.ownerToken, '/v1/tasks', { method: 'POST',
    body: JSON.stringify({ task: 'example-app/report/build', input: { title: '无效时间' },
      run_at: '2026-10-26' }) });
  assert.equal(invalid.response.status, 400);
});

test('历史任务分页、筛选及分级日志跨接口可读，Worker 权限隔离', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = new PlatformClient({ baseUrl: h.baseUrl, token: h.ownerToken, fetchImpl: h.fetchImpl });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await client.submitTask('example-app/report/build', { title: `历史 ${i}` })).task.task_id);
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTasks({ appId: 'example-app', taskKey: 'report/build', limit: 1, cursor });
    seen.push(...page.tasks.map((task) => task.task_id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  assert.deepEqual(new Set(seen), new Set(ids));
  assert.equal((await client.listTasks({ status: 'failed' })).tasks.length, 0);
  assert.equal((await request(h, h.ownerToken, '/v1/tasks?cursor=bad')).response.status, 400);
  assert.equal((await request(h, h.ownerToken, '/v1/tasks?limit=101')).response.status, 400);
  assert.equal((await request(h, h.ownerToken, '/v1/tasks?status=unknown')).response.status, 400);
  assert.equal((await request(h, h.workerToken, '/v1/tasks')).response.status, 401);

  const worker = new WorkerClient({ baseUrl: h.baseUrl, token: h.workerToken, fetchImpl: h.fetchImpl });
  const lease = await worker.lease();
  assert.ok(lease);
  await worker.log(lease, 'warn', '示例警告');
  await worker.complete(lease, (await worker.uploadTextArtifact(lease, 'test.txt', 'ok')));
  const logs = await client.getLogs(lease.task_id);
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].level, 'warn');
  assert.equal(logs.logs[0].message, '示例警告');
  assert.equal(logs.logs[0].attempt_id, lease.attempt_id);
  assert.equal((await client.getLogs(lease.task_id, logs.logs[0].id)).logs.length, 0);
  assert.equal((await request(h, h.workerToken, `/v1/tasks/${lease.task_id}/logs`)).response.status, 401);
  const late = await request(h, h.workerToken, `/v1/worker/tasks/${lease.task_id}/logs`, {
    method: 'POST', headers: { 'x-attempt-id': lease.attempt_id },
    body: JSON.stringify({ level: 'info', message: '迟到日志' }),
  });
  assert.equal(late.response.status, 409);
  assert.equal((await client.listTasks({ status: 'succeeded' })).tasks.length, 1);
  const failedLease = await worker.lease();
  assert.ok(failedLease);
  await worker.fail(failedLease, '示例失败');
  assert.deepEqual(await client.getResult(failedLease.task_id), {
    task_id: failedLease.task_id, status: 'failed', output: null,
    artifact_id: null, error: '示例失败',
  });
  assert.equal((await client.listTasks({ status: 'failed' })).tasks.length, 1);
});
