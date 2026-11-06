#!/usr/bin/env node
/** Demo Worker：验证底座「领取 → 进度 → 检查点 → 产物 → 完成」闭环。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RemoteError, WorkerClient, sleep, type WorkerClientOptions, type WorkerLease,
} from './worker-sdk.ts';

export type DemoWorkerOptions = WorkerClientOptions & {
  pollMs?: number;
  delayMs?: number;
};

type DemoInput = { text: string; artifact?: boolean };

function assertInput(input: unknown): DemoInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('demo/echo 输入必须是对象');
  }
  const record = input as Record<string, unknown>;
  if (typeof record.text !== 'string' || record.text.length === 0) {
    throw new Error('demo/echo 输入 text 必须是非空字符串');
  }
  if (record.artifact !== undefined && typeof record.artifact !== 'boolean') {
    throw new Error('demo/echo 输入 artifact 必须是 boolean');
  }
  return { text: record.text, ...(record.artifact === undefined ? {} : { artifact: record.artifact }) };
}

export async function executeDemoLease(client: WorkerClient, lease: WorkerLease,
  options: DemoWorkerOptions): Promise<void> {
  if (lease.app_id !== 'demo' || lease.task_key !== 'echo') {
    throw new Error('Demo Worker 不支持该任务');
  }
  const input = assertInput(lease.input);
  await client.withHeartbeat(lease, async (active, signal) => {
    await active.log(lease, 'info', '开始执行 demo/echo');
    let prepared = active.stepValue<{ text: string }>(lease, 'prepare');
    if (!prepared) {
      await sleep(options.delayMs ?? 200, signal);
      prepared = { text: input.text.trim() };
      await active.saveStep(lease, 'prepare', prepared);
    }
    await active.progress(lease, 40, '准备完成');

    let rendered = active.stepValue<string>(lease, 'render');
    if (!rendered) {
      await sleep(options.delayMs ?? 200, signal);
      rendered = `echo: ${prepared.text}`;
      await active.saveStep(lease, 'render', rendered);
    }
    await active.progress(lease, 80, '渲染完成');

    let artifactId: string | undefined;
    if (input.artifact) {
      artifactId = await active.uploadArtifact(lease, 'echo.txt',
        Buffer.from(`${rendered}\n`, 'utf8'), 'text/plain');
    }
    await active.complete(lease, {
      echo: rendered,
      ...(artifactId ? { artifact_id: artifactId } : {}),
    });
  });
}

export async function runDemoOnce(options: DemoWorkerOptions): Promise<boolean> {
  const client = new WorkerClient(options);
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executeDemoLease(client, lease, options);
  } catch (error) {
    const stale = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    if (!stale && !(error instanceof RemoteError && error.status >= 500)) {
      await client.fail(lease, error instanceof Error ? error.message.slice(0, 1000) : 'Demo 任务失败')
        .catch(() => {});
    }
    if (!stale) throw error;
  }
  return true;
}

async function main(): Promise<void> {
  const token = process.env.TASKBASE_WORKER_TOKEN;
  if (!token) {
    throw new Error('请设置 TASKBASE_WORKER_TOKEN（运行 app register 后获得）');
  }
  const options: DemoWorkerOptions = {
    baseUrl: process.env.TASKBASE_URL ?? 'http://127.0.0.1:3333',
    token,
    pollMs: Number(process.env.TASKBASE_POLL_MS ?? 1_000),
    heartbeatMs: Number(process.env.TASKBASE_HEARTBEAT_MS ?? 15_000),
  };
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  console.log('Demo Worker 已启动');
  while (!controller.signal.aborted) {
    try {
      const worked = await runDemoOnce(options);
      if (!worked) await sleep(options.pollMs ?? 1_000, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('Demo Worker 循环出错', error);
      await sleep(2_000, controller.signal).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
