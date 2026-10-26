/** 时间查询 CLI → HTTP API → 独立 Worker → JSON 结果的集成测试。 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runTimeTaskOnce } from '../apps/time-worker/src/main.ts';
import { createApiServer } from '../apps/platform-api/src/server.ts';
import { parseManifest } from '../packages/core/src/manifest.ts';
import { AppError, Store } from '../packages/core/src/store.ts';

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

test('新 CLI 提交时间查询，服务器 Worker 返回自己的 UTC 时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-time-'));
  const priorConfigDir = process.env.TIME_CLI_DIR;
  const priorPassword = process.env.TIME_CLI_PASSWORD;
  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  process.env.TIME_CLI_DIR = join(dir, 'cli');
  process.env.TIME_CLI_PASSWORD = 'a-long-test-password';
  const store = new Store(join(dir, 'platform.sqlite'));
  store.bootstrap('owner', 'a-long-test-password');
  const manifest = parseManifest(JSON.parse(await readFile('apps/time-worker/manifest.json', 'utf8')) as unknown);
  const workerToken = store.registerApplication(manifest);
  const server = createApiServer(store, { artifactDir: join(dir, 'artifacts'), sweepMs: 20 });
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? Buffer.from(init.body as string | Uint8Array) : Buffer.alloc(0);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (body.length) headers['content-length'] = String(body.length);
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
  globalThis.fetch = localFetch;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };

  try {
    const { main } = await import('../apps/time-cli/src/main.ts');
    await main(['config', 'set-server', 'http://127.0.0.1:3333']);
    await main(['login']);
    const query = main(['query', 'time', '--json']);
    // CLI 已经提交任务后，由独立 Worker 通过相同 HTTP API 领取。
    let worked = false;
    for (let attempt = 0; attempt < 20 && !worked; attempt += 1) {
      worked = await runTimeTaskOnce({
        baseUrl: 'http://127.0.0.1:3333',
        token: workerToken,
        fetchImpl: localFetch,
        now: () => new Date('2026-10-26T01:02:03.000Z'),
      });
      if (!worked) await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(worked, true);
    await query;
    const result = JSON.parse(logs.at(-1) as string) as {
      task_id: string; server_time: string; timezone: string;
    };
    assert.equal(result.server_time, '2026-10-26T01:02:03.000Z');
    assert.equal(result.timezone, 'UTC');
    assert.equal(store.getTask(result.task_id).status, 'succeeded');
    assert.deepEqual(store.getTask(result.task_id).output, {
      server_time: result.server_time, timezone: 'UTC',
    });
    assert.equal(store.getTask(result.task_id).artifact_id, null);
    await main(['task', 'get', result.task_id]);
    assert.match(logs.at(-1) as string, /2026-10-26T01:02:03.000Z/);
    await assert.rejects(main(['task', 'get', result.task_id, '--server', 'http://localhost:3333']),
      /服务器地址已更改，请重新登录/);
  } finally {
    server.emit('close');
    store.close();
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    if (priorConfigDir === undefined) delete process.env.TIME_CLI_DIR;
    else process.env.TIME_CLI_DIR = priorConfigDir;
    if (priorPassword === undefined) delete process.env.TIME_CLI_PASSWORD;
    else process.env.TIME_CLI_PASSWORD = priorPassword;
    await rm(dir, { recursive: true, force: true });
  }
});

test('时间任务的输出 schema 拒绝无效结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-time-schema-'));
  const store = new Store(join(dir, 'platform.sqlite'));
  try {
    store.bootstrap('owner', 'a-long-test-password');
    const manifest = parseManifest(JSON.parse(await readFile('apps/time-worker/manifest.json', 'utf8')) as unknown);
    store.registerApplication(manifest);
    const task = store.createTask('user:owner', 'time-service', 'time/now', {}, null).task;
    assert.equal(store.lease('example-app', 'mvp-v1', 60_000), null);
    const lease = store.lease('time-service', 'time-v1', 60_000);
    assert.ok(lease);
    assert.throws(() => store.complete(task.task_id, lease.attempt_id, 'time-service', { timezone: 'UTC' }),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_OUTPUT');
    assert.equal(store.getTask(task.task_id).status, 'running');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
