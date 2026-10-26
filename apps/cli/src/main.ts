#!/usr/bin/env node
/**
 * 个人 CLI 入口：解析终端命令，配置服务器并通过用户侧 SDK 操作任务。
 * 本模块不读取平台数据库；持久化配置和凭据由 config.ts 管理。
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlatformClient, type TaskStatus } from '../../../packages/client-sdk/src/index.ts';
import { configuredServer, forgetToken, readToken, resolveServer, saveServer, saveToken } from './config.ts';

const MAX_INPUT_BYTES = 60 * 1024;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}

async function passwordPrompt(): Promise<string> {
  if (process.env.PLATFORM_PASSWORD) return process.env.PLATFORM_PASSWORD;
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('非交互环境请设置 PLATFORM_PASSWORD');
  }
  return new Promise<string>((resolvePassword, reject) => {
    const passwordBytes: number[] = [];
    const previousRaw = process.stdin.isRaw;
    process.stdout.write('密码: ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(previousRaw);
          process.stdin.pause();
          process.stdout.write('\n');
          resolvePassword(Buffer.from(passwordBytes).toString('utf8'));
          return;
        }
        if (byte === 3) {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(previousRaw);
          process.stdin.pause();
          process.stdout.write('\n');
          reject(new Error('已取消登录'));
          return;
        }
        if (byte === 127 || byte === 8) {
          let removed = passwordBytes.pop();
          while (removed !== undefined && (removed & 0xc0) === 0x80) {
            removed = passwordBytes.pop();
          }
        } else passwordBytes.push(byte);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function client(server: string): Promise<PlatformClient> {
  return new PlatformClient({ baseUrl: server, token: await readToken(server) });
}

async function login(server: string, username: string, password: string): Promise<string> {
  const response = await fetch(new URL('/v1/auth/cli-token', server), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json() as { token?: string; error?: { code?: string; message?: string; request_id?: string } };
  if (!response.ok) {
    const requestId = data.error?.request_id ? ` (request_id: ${data.error.request_id})` : '';
    throw new Error(`${data.error?.code ?? response.status}: ${data.error?.message ?? '登录失败'}${requestId}`);
  }
  if (typeof data.token !== 'string' || data.token.length === 0) throw new Error('服务器未返回有效令牌');
  return data.token;
}

/** 文件、标准输入和内联 JSON 三选一；省略输入时提交空对象。 */
export async function taskInput(args: string[], stdin: AsyncIterable<Uint8Array> = process.stdin): Promise<unknown> {
  const file = option(args, '--input');
  const inline = option(args, '--input-json');
  if (file && inline) throw new Error('--input 与 --input-json 只能选择一个');
  if (!file && !inline) return {};
  let raw: string;
  if (inline !== undefined) raw = inline;
  else if (file === '-') {
    if (stdin === process.stdin && process.stdin.isTTY) throw new Error('--input - 需要通过管道提供 JSON');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) throw new Error('任务输入超过 60 KiB');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    const path = resolve(file as string);
    if ((await stat(path)).size > MAX_INPUT_BYTES) throw new Error('任务输入超过 60 KiB');
    raw = await readFile(path, 'utf8');
  }
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error('任务输入超过 60 KiB');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new Error('任务输入不是有效的 JSON'); }
  // 请求由 JSON.stringify 序列化；按实际网络载荷计数，避免转义后超过平台限制。
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_INPUT_BYTES) throw new Error('任务输入序列化后超过 60 KiB');
  return parsed;
}

function timeoutSeconds(args: string[], fallback?: number): number | undefined {
  const raw = option(args, '--timeout');
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new Error('--timeout 必须是 1 至 86400 秒的整数');
  }
  return value;
}

/** 拒绝拼错或当前命令不支持的选项，避免输入看似生效却被静默忽略。 */
function validateOptions(args: string[], values: string[], switches: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    if (switches.includes(current)) continue;
    if (!values.includes(current)) throw new Error(`未知选项: ${current}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${current} 缺少参数值`);
    index++;
  }
}

/** 使用事件游标展示进展；超时只停止本地等待，不取消远端任务。 */
async function watchTask(apiClient: PlatformClient, taskId: string, timeout?: number): Promise<void> {
  const deadline = timeout === undefined ? null : Date.now() + timeout * 1000;
  let cursor = 0;
  while (true) {
    const data = await apiClient.getEvents(taskId, cursor);
    for (const event of data.events) {
      console.log(`${event.id} ${event.type} ${JSON.stringify(event.payload)}`);
      cursor = event.id;
    }
    const task = await apiClient.getTask(taskId);
    if (['succeeded', 'failed'].includes(task.status)) {
      console.log(`任务状态: ${task.status}${task.artifact_id ? `，产物 ID: ${task.artifact_id}` : ''}`);
      print(await apiClient.getResult(taskId));
      if (task.status === 'failed') process.exitCode = 1;
      return;
    }
    if (deadline !== null && Date.now() >= deadline) {
      throw new Error(`等待任务 ${taskId} 超时；任务仍在平台运行，可稍后执行 task result ${taskId}`);
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usageText(): string {
  return `用法:
  yuxu config set-server <URL>
  yuxu config show
  yuxu login [--username <name>]
  yuxu logout [--server <URL>]
  yuxu apps list
  yuxu tasks list <app-id>
  yuxu tasks history [--app <app-id>] [--task-key <key>] [--status <status>] [--limit <1-100>] [--cursor <cursor>]
  yuxu task run <app-id/task-key> [--input <file.json|-> | --input-json <JSON>] [--run-at <ISO-8601>] [--idempotency-key <key>] [--wait] [--timeout <秒>]
  yuxu task get <task-id>
  yuxu task result <task-id>
  yuxu task logs <task-id> [--after <event-id>]
  yuxu task watch <task-id> [--timeout <秒>]
  yuxu artifact download <artifact-id> --out <path>

所有联网命令可使用 --server <URL> 临时指定服务器；远端地址须使用 HTTPS。`;
}

function usage(): never {
  throw new Error(usageText());
}

/** 解析并执行一条 CLI 命令；导出以便在进程内集成测试中复用。 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args[0] === 'help') {
    console.log(usageText());
    return;
  }
  if (args[0] === 'config' && args[1] === 'set-server' && args[2]) {
    validateOptions(args.slice(3), [], []);
    console.log(`服务器地址已设置为 ${await saveServer(args[2])}`);
    return;
  }
  if (args[0] === 'config' && args[1] === 'show') {
    const effective = await resolveServer(option(args, '--server'));
    print({ configured_server: await configuredServer(),
      effective_server: effective.server, source: effective.source });
    return;
  }
  if (args[0] === 'logout') {
    validateOptions(args.slice(1), ['--server'], []);
    const selected = option(args, '--server');
    const target = selected ? (await resolveServer(selected)).server : undefined;
    await forgetToken(target);
    console.log(target ? `已删除 ${target} 的本机令牌` : '已删除本机保存的全部令牌');
    return;
  }
  const { server } = await resolveServer(option(args, '--server'));
  if (args[0] === 'login') {
    validateOptions(args.slice(1), ['--username', '--server'], []);
    const username = option(args, '--username') ?? process.env.PLATFORM_ADMIN_USER ?? 'owner';
    const password = await passwordPrompt();
    await saveToken(server, await login(server, username, password));
    console.log(`已登录 ${server}`);
    return;
  }
  if (args[0] === 'apps' && args[1] === 'list') {
    validateOptions(args.slice(2), ['--server'], []);
    print(await (await client(server)).listApps());
    return;
  }
  if (args[0] === 'tasks' && args[1] === 'list' && args[2]) {
    validateOptions(args.slice(3), ['--server'], []);
    print(await (await client(server)).listDefinitions(args[2]));
    return;
  }
  if (args[0] === 'tasks' && args[1] === 'history') {
    validateOptions(args.slice(2), ['--app', '--task-key', '--status', '--limit', '--cursor', '--server'], []);
    const rawLimit = option(args, '--limit');
    print(await (await client(server)).listTasks({
      appId: option(args, '--app'), taskKey: option(args, '--task-key'),
      status: option(args, '--status') as TaskStatus | undefined,
      limit: rawLimit === undefined ? undefined : Number(rawLimit), cursor: option(args, '--cursor'),
    }));
    return;
  }
  if (args[0] === 'task' && args[1] === 'run' && args[2]) {
    validateOptions(args.slice(3), ['--input', '--input-json', '--run-at',
      '--idempotency-key', '--timeout', '--server'], ['--wait']);
    if (args.includes('--timeout') && !args.includes('--wait')) {
      throw new Error('--timeout 仅能与 --wait 一起使用');
    }
    const input = await taskInput(args);
    const apiClient = await client(server);
    const submitted = await apiClient.submitTask(args[2], input, {
      runAt: option(args, '--run-at'), idempotencyKey: option(args, '--idempotency-key'),
    });
    print(submitted);
    if (args.includes('--wait')) await watchTask(apiClient, submitted.task.task_id, timeoutSeconds(args, 3600));
    return;
  }
  if (args[0] === 'task' && args[1] === 'get' && args[2]) {
    validateOptions(args.slice(3), ['--server'], []);
    print(await (await client(server)).getTask(args[2]));
    return;
  }
  if (args[0] === 'task' && args[1] === 'result' && args[2]) {
    validateOptions(args.slice(3), ['--server'], []);
    print(await (await client(server)).getResult(args[2]));
    return;
  }
  if (args[0] === 'task' && args[1] === 'logs' && args[2]) {
    validateOptions(args.slice(3), ['--after', '--server'], []);
    const after = Number(option(args, '--after') ?? '0');
    print(await (await client(server)).getLogs(args[2], after));
    return;
  }
  if (args[0] === 'task' && args[1] === 'watch' && args[2]) {
    validateOptions(args.slice(3), ['--timeout', '--server'], []);
    await watchTask(await client(server), args[2], timeoutSeconds(args));
    return;
  }
  if (args[0] === 'artifact' && args[1] === 'download' && args[2]) {
    validateOptions(args.slice(3), ['--out', '--server'], []);
    const out = option(args, '--out');
    if (!out) usage();
    const artifact = await (await client(server)).downloadArtifact(args[2]);
    await writeFile(resolve(out), artifact.data, { flag: 'wx', mode: 0o600 });
    console.log(`已下载到 ${resolve(out)}`);
    return;
  }
  usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
