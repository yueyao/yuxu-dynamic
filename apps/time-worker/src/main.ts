/**
 * 时间查询 Worker。任务在此进程执行，返回该进程所在服务器的 UTC 时间。
 * CLI 只提交请求和读取结果，不在客户端计算时间。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerClient, RemoteError, isTransientWorkerError, sleep,
  type WorkerClientOptions, type WorkerLease } from '../../../packages/worker-sdk/src/index.ts';

const APP_ID = 'time-service';
const TASK_KEY = 'time/now';
const RELEASE_DIGEST = 'time-v1';

export type TimeWorkerOptions = WorkerClientOptions & { now?: () => Date };

/** 一个领取周期；只有匹配版本的 Worker 才能获得此任务。 */
export async function runTimeTaskOnce(options: TimeWorkerOptions): Promise<boolean> {
  const client = new WorkerClient(options);
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executeTimeTask(client, lease, options.now ?? (() => new Date()));
  } catch (error) {
    const stale = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    if (!stale && !isTransientWorkerError(error) && !options.signal?.aborted) {
      await client.fail(lease, (error as Error).message.slice(0, 1000) || '时间查询失败')
        .catch((failure) => console.error('提交失败状态时出错', failure));
    }
    if (!stale) throw error;
  }
  return true;
}

/** 服务器生成时间，直接作为结构化任务输出提交。 */
export async function executeTimeTask(client: WorkerClient, lease: WorkerLease, now: () => Date): Promise<void> {
  if (lease.task_key !== TASK_KEY || lease.release_digest !== RELEASE_DIGEST ||
    lease.app_id !== APP_ID) {
    throw new Error('时间 Worker 不支持该任务定义或版本');
  }
  if (typeof lease.input !== 'object' || lease.input === null ||
    Array.isArray(lease.input) || Object.keys(lease.input).length !== 0) {
    throw new Error('时间查询不接受输入字段');
  }
  await client.withHeartbeat(lease, async (activeClient) => {
    await activeClient.completeWithOutput(lease, {
      server_time: now().toISOString(),
      timezone: 'UTC',
    });
  });
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
  const token = process.env.TIME_WORKER_TOKEN ??
    (await readFile(resolve(dataDir, `worker-token-${APP_ID}`), 'utf8')).trim();
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  const options: TimeWorkerOptions = {
    baseUrl: process.env.PLATFORM_URL ?? 'http://127.0.0.1:3333',
    token,
    signal: controller.signal,
  };
  console.log('时间查询 Worker 已启动');
  while (!controller.signal.aborted) {
    try {
      const worked = await runTimeTaskOnce(options);
      if (!worked) await sleep(1000, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('时间查询 Worker 出错', error);
      await sleep(2000, controller.signal).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
