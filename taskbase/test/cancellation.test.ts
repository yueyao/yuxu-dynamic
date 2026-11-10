import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../src/process.ts';
import { RemoteError, WorkerClient, type WorkerLease } from '../src/worker-sdk.ts';

test('心跳失效会中止正在运行的子进程，等待退出后返回', async () => {
  const client = new WorkerClient({ baseUrl: 'http://mock.invalid', token: 'token', heartbeatMs: 50,
    fetchImpl: async () => Response.json({ error: { code: 'STALE_ATTEMPT', message: 'lease lost' } }, { status: 409 }),
  });
  const lease = { task_id: 'task', attempt_id: 'attempt' } as WorkerLease;
  const started = Date.now();
  await assert.rejects(client.withHeartbeat(lease, async (_client, signal) => {
    await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal });
  }), (error: unknown) => error instanceof RemoteError && error.code === 'STALE_ATTEMPT');
  assert.ok(Date.now() - started < 5000);
});

test('Worker 退出信号与子进程超时均能中止执行', async () => {
  const controller = new AbortController();
  const client = new WorkerClient({ baseUrl: 'http://mock.invalid', token: 'token' });
  const work = client.withHeartbeat({} as WorkerLease, async (_client, signal) => {
    await delay(60_000, undefined, { signal });
  }, controller.signal);
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 50,
  }), { name: 'TimeoutError' });
});
