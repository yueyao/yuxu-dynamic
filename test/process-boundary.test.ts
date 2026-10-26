/** 独立 CLI、API、Worker 进程的端到端测试；沙箱内用 IPC 承载 HTTP 请求。 */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { parseManifest } from '../packages/core/src/manifest.ts';
import { Store } from '../packages/core/src/store.ts';

const root = resolve('.');
const preload = resolve('test/support/ipc-fetch.ts');

type RoutedResponse = { kind: 'http-response'; route: string; id: number };

test('三个独立进程完成时间查询任务', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-process-'));
  const dataDir = join(dir, 'platform');
  const clientDir = join(dir, 'client');
  const store = new Store(join(dataDir, 'platform.sqlite'));
  store.bootstrap('owner', 'a-long-test-password');
  const manifest = parseManifest(JSON.parse(await readFile('apps/time-worker/manifest.json', 'utf8')) as unknown);
  const workerToken = store.registerApplication(manifest);
  store.close();

  const children = new Map<string, ChildProcess>();
  const baseEnv = { ...process.env, PLATFORM_DATA_DIR: dataDir,
    TIME_CLI_DIR: clientDir, TIME_CLI_PASSWORD: 'a-long-test-password' };
  const api = fork(resolve('test/support/ipc-api.ts'), [], {
    cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let apiStderr = '';
  let apiReady = false;
  api.stderr?.on('data', (chunk: Buffer) => { apiStderr += chunk.toString(); });
  api.on('message', (raw: unknown) => {
    const message = raw as RoutedResponse;
    if ((message as { kind?: string })?.kind === 'ready') apiReady = true;
    if (message?.kind !== 'http-response') return;
    children.get(message.route)?.send(message);
  });

  const spawnClient = (route: string, module: string, args: string[], extraEnv: Record<string, string> = {}) => {
    const child = fork(resolve(module), args, {
      cwd: root, env: { ...baseEnv, ...extraEnv },
      execArgv: ['--import', preload],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.set(route, child);
    child.on('message', (raw: unknown) => {
      const message = raw as { kind?: string };
      if (message?.kind === 'http-request') api.send({ ...message, route });
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    return { child, output: () => ({ stdout, stderr }) };
  };

  const runCli = async (route: string, args: string[]) => {
    const processHandle = spawnClient(route, 'apps/time-cli/src/main.ts', args);
    const [code] = await once(processHandle.child, 'exit') as [number | null];
    children.delete(route);
    assert.equal(code, 0, `${args.join(' ')} 失败：${processHandle.output().stderr}\n${apiStderr}`);
    return processHandle.output().stdout;
  };

  try {
    await new Promise<void>((resolveReady, reject) => {
      if (apiReady) { resolveReady(); return; }
      if (api.exitCode !== null) { reject(new Error(apiStderr)); return; }
      const onMessage = (raw: unknown) => {
        if ((raw as { kind?: string })?.kind === 'ready') {
          api.off('message', onMessage);
          resolveReady();
        }
      };
      api.on('message', onMessage);
      api.once('exit', () => reject(new Error(`API 进程提前退出：${apiStderr}`)));
    });
    await runCli('config', ['config', 'set-server', 'http://127.0.0.1:3333']);
    await runCli('login', ['login']);
    const worker = spawnClient('worker', 'apps/time-worker/src/main.ts', [], {
      TIME_WORKER_TOKEN: workerToken,
    });
    const resultText = await runCli('query', ['query', 'time', '--json', '--timeout', '10']);
    const result = JSON.parse(resultText.trim()) as { task_id: string; server_time: string; timezone: string };
    assert.equal(result.timezone, 'UTC');
    assert.ok(!Number.isNaN(Date.parse(result.server_time)));
    assert.ok(Math.abs(Date.now() - Date.parse(result.server_time)) < 10_000);
    assert.ok(result.task_id);
    assert.equal(worker.child.exitCode, null, worker.output().stderr);
    const check = new Store(join(dataDir, 'platform.sqlite'));
    try { assert.equal(check.getTask(result.task_id).status, 'succeeded'); }
    finally { check.close(); }
  } finally {
    const active = [...children.values()].filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of active) child.kill('SIGTERM');
    const apiActive = api.exitCode === null && api.signalCode === null;
    if (apiActive) api.kill('SIGTERM');
    await Promise.allSettled([
      ...(apiActive ? [once(api, 'exit')] : []),
      ...active.map((child) => once(child, 'exit')),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});
