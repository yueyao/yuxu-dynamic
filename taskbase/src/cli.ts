#!/usr/bin/env node
/** Taskbase CLI：登录、应用注册、任务提交/查看/关闭/重试、产物下载。 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Session = { server: string; token: string };

const DEFAULT_SERVER = 'http://127.0.0.1:3333';
const MAX_INPUT_BYTES = 64 * 1024;

function configRoot(): string {
  return resolve(process.env.TASKBASE_CONFIG_DIR ?? join(homedir(), '.config', 'taskbase'));
}

function sessionPath(): string {
  return join(configRoot(), 'session.json');
}

async function readSession(): Promise<Session | null> {
  try {
    const value = JSON.parse(await readFile(sessionPath(), 'utf8')) as Session;
    if (typeof value.server !== 'string' || typeof value.token !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

async function writeSession(session: Session): Promise<void> {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

async function resolveServer(explicit?: string): Promise<string> {
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.TASKBASE_URL) return process.env.TASKBASE_URL.replace(/\/+$/, '');
  const session = await readSession();
  if (session) return session.server;
  return DEFAULT_SERVER;
}

async function request(server: string, path: string,
  options: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; data: unknown }> {
  const response = await fetch(new URL(path, server), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) as unknown : null; } catch { data = text; }
  if (!response.ok) {
    const error = data as { error?: { code?: string; message?: string; request_id?: string } } | null;
    const code = error?.error?.code ?? String(response.status);
    const message = error?.error?.message ?? '请求失败';
    const requestId = error?.error?.request_id ? ` (request_id: ${error.error.request_id})` : '';
    throw new Error(`${code}: ${message}${requestId}`);
  }
  return { status: response.status, data };
}

async function authenticated(server: string): Promise<string> {
  const session = await readSession();
  if (!session) throw new Error('尚未登录，请先运行 taskbase login');
  if (session.server !== server) throw new Error('登录凭据属于另一个服务器，请重新 login');
  return session.token;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function promptPassword(): Promise<string> {
  if (process.env.TASKBASE_PASSWORD) return process.env.TASKBASE_PASSWORD;
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('非交互环境请设置 TASKBASE_PASSWORD');
  }
  return new Promise<string>((resolvePassword, reject) => {
    const bytes: number[] = [];
    const previous = process.stdin.isRaw;
    process.stdout.write('密码: ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(previous);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolvePassword(Buffer.from(bytes).toString('utf8'));
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) { finish(); return; }
        if (byte === 3) { finish(new Error('已取消登录')); return; }
        if (byte === 127 || byte === 8) {
          let removed = bytes.pop();
          while (removed !== undefined && (removed & 0xc0) === 0x80) removed = bytes.pop();
        } else {
          bytes.push(byte);
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function taskInput(args: string[]): Promise<unknown> {
  const file = option(args, '--input');
  const inline = option(args, '--input-json');
  if (file && inline) throw new Error('--input 与 --input-json 只能选择一个');
  if (!file && !inline) return {};
  let raw: string;
  if (inline !== undefined) raw = inline;
  else if (file === '-') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) throw new Error('任务输入超过 64 KiB');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    const path = resolve(file as string);
    raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error('任务输入超过 64 KiB');
  }
  try { return JSON.parse(raw) as unknown; } catch { throw new Error('任务输入不是有效 JSON'); }
}

async function waitTask(server: string, token: string, taskId: string, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let cursor = 0;
  while (true) {
    const events = await request(server, `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${cursor}`, { token });
    const list = (events.data as { events: Array<{ id: number; type: string; payload: unknown }> }).events;
    for (const event of list) {
      console.log(`${event.id} ${event.type} ${JSON.stringify(event.payload)}`);
      cursor = event.id;
    }
    const task = (await request(server, `/v1/tasks/${encodeURIComponent(taskId)}`, { token })).data as
      { status: string; artifact_id?: string | null };
    if (['succeeded', 'failed', 'closed'].includes(task.status)) {
      const result = await request(server, `/v1/tasks/${encodeURIComponent(taskId)}/result`, { token });
      print(result.data);
      if (task.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待任务超时；任务仍在平台运行，可稍后执行 taskbase task result ${taskId}`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

function usage(): string {
  return `用法:
  taskbase login [--server <URL>] [--username <name>]
  taskbase logout
  taskbase apps list
  taskbase app register <manifest.json>
  taskbase app rotate-token <app-id>
  taskbase schedule add --app <app-id> --task <task-key> --cron "<5字段>" --timezone <IANA> [--input-json <JSON> | --input <file>] [--disabled]
  taskbase schedule list
  taskbase schedule get <schedule-id>
  taskbase schedule update <schedule-id> [--cron <expr>] [--timezone <IANA>] [--input-json <JSON>] [--enable | --disable]
  taskbase schedule remove <schedule-id>
  taskbase schedule run-now <schedule-id>
  taskbase schedule runs <schedule-id>
  taskbase task run <app-id/task-key> [--input <file|-> | --input-json <JSON>] [--idempotency-key <key>] [--wait] [--timeout <秒>]
  taskbase task get <task-id>
  taskbase task result <task-id>
  taskbase task events <task-id> [--after <event-id>]
  taskbase task logs <task-id> [--after <event-id>]
  taskbase task close <task-id> [--reason <text>]
  taskbase task retry <task-id>
  taskbase task history [--app <app-id>] [--task-key <key>] [--status <status>] [--schedule <schedule-id>] [--limit <1-100>] [--cursor <cursor>]
  taskbase artifact download <artifact-id> --out <path>

所有联网命令都可加 --server <URL>；未指定时依次使用 TASKBASE_URL、已登录服务器、${DEFAULT_SERVER}。`;
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help')) {
    console.log(usage());
    return;
  }

  if (args[0] === 'logout') {
    await rm(sessionPath(), { force: true });
    console.log('已删除本机登录凭据');
    return;
  }

  const explicitServer = option(args, '--server');

  if (args[0] === 'login') {
    const server = await resolveServer(explicitServer);
    const username = option(args, '--username') ?? process.env.TASKBASE_OWNER_USERNAME ?? 'owner';
    const password = await promptPassword();
    const result = await request(server, '/v1/auth/login', { method: 'POST', body: { username, password } });
    const token = (result.data as { token: string }).token;
    await writeSession({ server, token });
    console.log(`已登录 ${server}`);
    return;
  }

  const server = await resolveServer(explicitServer);
  const token = await authenticated(server);

  if (args[0] === 'apps' && args[1] === 'list') {
    print((await request(server, '/v1/apps', { token })).data);
    return;
  }

  if (args[0] === 'app' && args[1] === 'register' && args[2]) {
    const manifest = JSON.parse(await readFile(resolve(args[2]), 'utf8')) as unknown;
    const result = await request(server, '/v1/apps', { method: 'POST', token, body: manifest });
    print(result.data);
    const workerToken = (result.data as { worker_token?: string }).worker_token;
    if (workerToken) {
      console.log('\nWorker Token（只显示一次，请保存到 Worker 环境变量）：');
      console.log(workerToken);
    }
    return;
  }

  if (args[0] === 'app' && args[1] === 'rotate-token' && args[2]) {
    const result = await request(server, `/v1/apps/${encodeURIComponent(args[2])}/worker-token`, { method: 'POST', token });
    print(result.data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'add') {
    const appId = option(args, '--app');
    const taskKey = option(args, '--task');
    const cron = option(args, '--cron');
    const timezone = option(args, '--timezone');
    if (!appId || !taskKey || !cron || !timezone) {
      throw new Error('schedule add 需要 --app、--task、--cron、--timezone');
    }
    const input = await taskInput(args);
    const result = await request(server, '/v1/schedules', {
      method: 'POST', token,
      body: { app_id: appId, task_key: taskKey, input, cron, timezone, enabled: !has(args, '--disabled') },
    });
    print(result.data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'list') {
    print((await request(server, '/v1/schedules', { token })).data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'get' && args[2]) {
    print((await request(server, `/v1/schedules/${encodeURIComponent(args[2])}`, { token })).data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'update' && args[2]) {
    const body: Record<string, unknown> = {};
    const cron = option(args, '--cron');
    const timezone = option(args, '--timezone');
    if (cron !== undefined) body.cron = cron;
    if (timezone !== undefined) body.timezone = timezone;
    if (has(args, '--input') || has(args, '--input-json')) body.input = await taskInput(args);
    if (has(args, '--enable')) body.enabled = true;
    if (has(args, '--disable')) body.enabled = false;
    const result = await request(server, `/v1/schedules/${encodeURIComponent(args[2])}`, {
      method: 'PATCH', token, body,
    });
    print(result.data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'remove' && args[2]) {
    print((await request(server, `/v1/schedules/${encodeURIComponent(args[2])}`,
      { method: 'DELETE', token })).data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'run-now' && args[2]) {
    print((await request(server, `/v1/schedules/${encodeURIComponent(args[2])}/run-now`,
      { method: 'POST', token })).data);
    return;
  }

  if (args[0] === 'schedule' && args[1] === 'runs' && args[2]) {
    print((await request(server, `/v1/schedules/${encodeURIComponent(args[2])}/runs`, { token })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'run' && args[2]) {
    const input = await taskInput(args);
    const headers: Record<string, string> = {};
    const idempotencyKey = option(args, '--idempotency-key');
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetch(new URL('/v1/tasks', server), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ task: args[2], input }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const data = JSON.parse(text) as unknown;
    if (!response.ok) throw new Error(JSON.stringify(data));
    print(data);
    const taskId = (data as { task: { task_id: string } }).task.task_id;
    if (has(args, '--wait')) {
      const rawTimeout = option(args, '--timeout');
      const timeout = rawTimeout === undefined ? 3600 : Number(rawTimeout);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400) {
        throw new Error('--timeout 必须是 1–86400 秒的整数');
      }
      await waitTask(server, token, taskId, timeout);
    }
    return;
  }

  if (args[0] === 'task' && args[1] === 'get' && args[2]) {
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[2])}`, { token })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'result' && args[2]) {
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[2])}/result`, { token })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'events' && args[2]) {
    const after = option(args, '--after') ?? '0';
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[2])}/events?after=${encodeURIComponent(after)}`, { token })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'logs' && args[2]) {
    const after = option(args, '--after') ?? '0';
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[2])}/logs?after=${encodeURIComponent(after)}`, { token })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'close' && args[2]) {
    const reason = option(args, '--reason') ?? 'manual';
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[2])}/close`,
      { method: 'POST', token, body: { reason } })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'retry' && args[2]) {
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[2])}/retry`, { method: 'POST', token })).data);
    return;
  }

  if (args[0] === 'task' && args[1] === 'history') {
    const query = new URLSearchParams();
    for (const [flag, key] of [['--app', 'app_id'], ['--task-key', 'task_key'], ['--status', 'status'],
      ['--schedule', 'schedule_id'], ['--limit', 'limit'], ['--cursor', 'cursor']] as const) {
      const value = option(args, flag);
      if (value !== undefined) query.set(key, value);
    }
    print((await request(server, `/v1/tasks?${query}`, { token })).data);
    return;
  }

  if (args[0] === 'artifact' && args[1] === 'download' && args[2]) {
    const out = option(args, '--out');
    if (!out) throw new Error('缺少 --out');
    const response = await fetch(new URL(`/v1/artifacts/${encodeURIComponent(args[2])}/download`, server), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text);
    }
    const data = Buffer.from(await response.arrayBuffer());
    const target = resolve(out);
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    console.log(`已下载到 ${target}`);
    return;
  }

  throw new Error(usage());
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
