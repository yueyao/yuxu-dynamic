/**
 * 示例应用 Worker：实现 `report/build` 的两个可恢复步骤。
 * 任务领取、心跳、检查点和 HTTP 通信由 Worker SDK 提供。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleApp } from '../../../packages/core/src/model.ts';
import { validateJsonSchema } from '../../../packages/core/src/schema.ts';
import { RemoteError, WorkerClient, isTransientWorkerError, sleep,
  type WorkerClientOptions, type WorkerLease } from '../../../packages/worker-sdk/src/index.ts';

export type WorkerOptions = WorkerClientOptions & { delayMs?: number };

/** 执行已领取的尝试；已确认的步骤直接复用，最终产物仍在本次尝试中上传。 */
export async function executeLease(options: WorkerOptions, lease: WorkerLease): Promise<void> {
  if (lease.task_key !== exampleApp.taskKey || lease.release_digest !== exampleApp.releaseDigest) {
    throw new Error('Worker 不支持该任务版本');
  }
  const inputIssues = validateJsonSchema(exampleApp.inputSchema, lease.input);
  if (inputIssues.length > 0) throw new Error(inputIssues.map((issue) => `${issue.path} ${issue.message}`).join('；'));
  const input = lease.input as { title: string };

  await new WorkerClient(options).withHeartbeat(lease, async (client, signal) => {
    await client.log(lease, 'info', '开始处理报告任务');
    const delayMs = options.delayMs ?? 1_500;
    let prepared = client.stepValue<{ title: string }>(lease, 'prepare');
    if (!prepared) {
      await sleep(delayMs, signal);
      prepared = { title: input.title.trim() };
      await client.saveStep(lease, 'prepare', prepared);
    }
    await client.progress(lease, 40, '资料准备完成');

    let report = client.stepValue<string>(lease, 'render');
    if (!report) {
      await sleep(delayMs, signal);
      report = `# ${prepared.title}\n\n这是一份由示例任务生成的报告。\n`;
      await client.saveStep(lease, 'render', report);
    }
    await client.progress(lease, 80, '报告生成完成');
    await client.log(lease, 'info', '报告内容已生成，准备上传产物');
    const artifactId = await client.uploadTextArtifact(lease, 'report.txt', report);
    await client.complete(lease, artifactId);
  });
}

/** 领取并处理至多一个任务；返回 false 表示当前没有匹配任务。 */
export async function runOnce(options: WorkerOptions): Promise<boolean> {
  const client = new WorkerClient(options);
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executeLease(options, lease);
  } catch (error) {
    const staleAttempt = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    // 网络故障或租约丢失交由平台恢复，不能误记为任务业务失败。
    if (!isTransientWorkerError(error) && !staleAttempt && !options.signal?.aborted) {
      try {
        await client.fail(lease, (error as Error).message.slice(0, 1000) || '任务执行失败');
      } catch (failureError) {
        if (!(failureError instanceof RemoteError && failureError.code === 'STALE_ATTEMPT')) {
          console.error('提交任务失败状态时出错', failureError);
        }
      }
    }
    if (!staleAttempt) throw error;
  }
  return true;
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
  const token = process.env.WORKER_TOKEN ?? (await readFile(resolve(dataDir, 'worker-token'), 'utf8')).trim();
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  const options: WorkerOptions = {
    baseUrl: process.env.PLATFORM_URL ?? 'http://127.0.0.1:3333',
    token,
    delayMs: Number(process.env.EXAMPLE_TASK_DELAY_MS ?? 1_500),
    heartbeatMs: Number(process.env.WORKER_HEARTBEAT_MS ?? 15_000),
    signal: controller.signal,
  };
  console.log('示例 Worker 已启动');
  while (!controller.signal.aborted) {
    try {
      const worked = await runOnce(options);
      if (!worked) await sleep(Number(process.env.WORKER_POLL_MS ?? 2_000), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('Worker 循环出错', error);
      await sleep(2_000, controller.signal).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
