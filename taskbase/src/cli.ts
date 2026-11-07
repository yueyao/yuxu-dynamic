#!/usr/bin/env node
/** Taskbase CLI：登录、应用注册、任务提交/查看/关闭/重试、产物下载。 */
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValue } from './env.ts';

type Session = { server: string; token: string };

const DEFAULT_SERVER = 'http://127.0.0.1:3333';
const MAX_INPUT_BYTES = 64 * 1024;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function configRoot(): string {
  return resolve(envValue('YUXUN_CONFIG_DIR', 'TASKBASE_CONFIG_DIR',
    join(homedir(), '.config', 'yuxun')) as string);
}

function legacyConfigRoot(): string {
  return resolve(process.env.TASKBASE_CONFIG_DIR ?? join(homedir(), '.config', 'taskbase'));
}

function sessionPath(): string {
  return join(configRoot(), 'session.json');
}

async function readSession(): Promise<Session | null> {
  const parse = (raw: string): Session | null => {
    try {
      const value = JSON.parse(raw) as Session;
      return typeof value.server === 'string' && typeof value.token === 'string' ? value : null;
    } catch { return null; }
  };
  try {
    const value = parse(await readFile(sessionPath(), 'utf8'));
    if (value) return value;
  } catch {}
  // 旧路径迁移：只读取，登录后写回 ~/.config/yuxun。
  const legacy = join(legacyConfigRoot(), 'session.json');
  if (resolve(legacy) !== resolve(sessionPath())) {
    try {
      const value = parse(await readFile(legacy, 'utf8'));
      if (value) {
        await writeSession(value).catch(() => {});
        return value;
      }
    } catch {}
  }
  return null;
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
  const envServer = envValue('YUXUN_URL', 'TASKBASE_URL');
  if (envServer) return envServer.replace(/\/+$/, '');
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
  if (!session) throw new Error('尚未登录，请先运行 yuxun login');
  if (session.server !== server) throw new Error('登录凭据属于另一个服务器，请重新 login');
  return session.token;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function promptPassword(): Promise<string> {
  if (process.env.YUXUN_PASSWORD) return process.env.YUXUN_PASSWORD;
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

async function waitTask(server: string, token: string, taskId: string, timeoutSeconds: number): Promise<unknown> {
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
      return result.data;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待任务超时；任务仍在平台运行，可稍后执行 yuxun task result ${taskId}`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function usage(showAll = false): string {
  const common = `日常:
  yuxun login [--server <URL>]    登录
  yuxun logout                    退出登录
  yuxun status                    查看登录、服务端与 Worker 状态
  yuxun ps                        查看转写队列与任务
  yuxun transcribe <audio-url>    提交音频转写并保存 Markdown
  yuxun stop <task-id>            结束任务
  yuxun doctor                    本机环境自检
  yuxun version                   版本信息

Worker:
  yuxun worker <run|install|start|stop|status|logs|uninstall>`;
  if (!showAll) {
    return `yuxun — 玉虚个人远程任务平台

${common}

高级命令:
  yuxun help --all                查看任务、调度、应用等命令

所有联网命令都支持 --server <URL>。`;
  }
  return `yuxun — 全部命令

${common}

任务:
  yuxun task run <app-id/task-key> [--input <file|-> | --input-json <JSON>] [--wait] [--timeout <秒>]
  yuxun task history [--app <id>] [--task-key <key>] [--status <status>] [--limit <1-100>]
  yuxun task get|result|events|logs|close|retry <task-id>

平台:
  yuxun apps [list]
  yuxun app register <manifest.json>
  yuxun app rotate-token <app-id>
  yuxun schedule add|list|get|update|remove|run-now|runs
  yuxun artifact download <artifact-id> --out <path>

所有联网命令都支持 --server <URL>。`;
}

function groupUsage(group: string): string {
  switch (group) {
    case 'task':
      return `任务命令:
  yuxun task run <app-id/task-key> [--input <file|-> | --input-json <JSON>] [--idempotency-key <key>] [--wait] [--timeout <秒>]
  yuxun task history [--app <id>] [--task-key <key>] [--status <status>] [--schedule <id>] [--limit <1-100>] [--cursor <cursor>]
  yuxun task get <task-id>
  yuxun task result <task-id>
  yuxun task events <task-id> [--after <event-id>]
  yuxun task logs <task-id> [--after <event-id>]
  yuxun task close <task-id> [--reason <text>]
  yuxun task retry <task-id>`;
    case 'schedule':
      return `调度命令:
  yuxun schedule add --app <app-id> --task <task-key> --cron "<5字段>" --timezone <IANA> [--input-json <JSON> | --input <file>] [--disabled]
  yuxun schedule list
  yuxun schedule get <schedule-id>
  yuxun schedule update <schedule-id> [--cron <expr>] [--timezone <IANA>] [--input-json <JSON>] [--enable | --disable]
  yuxun schedule run-now <schedule-id>
  yuxun schedule runs <schedule-id>
  yuxun schedule remove <schedule-id>`;
    case 'apps':
    case 'app':
      return `应用命令:
  yuxun apps [list]
  yuxun app register <manifest.json>
  yuxun app rotate-token <app-id>`;
    case 'artifact':
      return `产物命令:
  yuxun artifact download <artifact-id> --out <path>`;
    case 'worker':
      return `Worker 命令:
  yuxun worker run                前台运行
  yuxun worker install            安装为 LaunchAgent
  yuxun worker start              启动后台服务
  yuxun worker stop               停止后台服务
  yuxun worker status             查看后台状态
  yuxun worker logs [-f]          查看日志
  yuxun worker doctor             检查 Worker 配置
  yuxun worker pair               绑定 Worker Token
  yuxun worker uninstall          卸载后台服务`;
    default:
      return usage();
  }
}

async function workerState(): Promise<{ state: string; pid?: string }> {
  const label = 'com.yuxun.worker';
  try {
    await access(join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`));
  } catch {
    return { state: '未安装' };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' });
  if (result.status !== 0) return { state: '未运行' };
  const text = result.stdout ?? '';
  return {
    state: /state = (\w+)/.exec(text)?.[1] ?? 'unknown',
    pid: /pid = (\d+)/.exec(text)?.[1],
  };
}

async function statusCommand(args: string[]): Promise<void> {
  const server = await resolveServer(option(args, '--server'));
  const session = await readSession();
  const loggedIn = Boolean(session && session.server === server);
  let health = '不可达';
  try {
    const response = await fetch(new URL('/api/health', server), { signal: AbortSignal.timeout(3000) });
    health = response.ok ? `正常（${response.status}）` : `异常（${response.status}）`;
  } catch {}
  const worker = await workerState();
  const workerText = worker.state === 'running'
    ? `运行中${worker.pid ? `（PID ${worker.pid}）` : ''}`
    : worker.state;
  console.log(`服务端：${server}`);
  console.log(`健康检查：${health}`);
  console.log(`登录：${loggedIn ? '已登录' : '未登录'}`);
  console.log(`Worker：${workerText}`);
  console.log(`版本：${await readVersion()}`);
  if (!loggedIn) console.log('\n提示：运行 yuxun login 登录');
  if (worker.state === '未安装') console.log('提示：运行 yuxun worker install 安装后台服务');
  else if (worker.state !== 'running') console.log('提示：运行 yuxun worker start 启动后台服务');
}

type TaskRow = {
  task_id: string;
  app_id: string;
  task_key: string;
  status: string;
  progress: number;
  input?: { title?: string; audio_url?: string; show_id?: string } | null;
};

type QueueSnapshot = {
  counts: Record<string, number>;
  paused: boolean;
  error: string | null;
  runner: boolean;
  items: Array<{
    id: string; show_id: string; show_title?: string | null; title: string;
    status: string; progress: number; enabled: boolean; task_id: string | null;
  }>;
};

function printQueue(snapshot: QueueSnapshot, args: string[]): void {
  const counts = snapshot.counts ?? {};
  console.log(`队列：待转写 ${counts.pending ?? 0}，运行中 ${counts.running ?? 0}，已完成 ${counts.done ?? 0}，失败 ${counts.failed ?? 0}`);
  const running = (counts.running ?? 0) > 0;
  if (snapshot.paused) console.log('状态：已暂停');
  else if (!snapshot.runner) {
    console.log(running
      ? '状态：调度未启动（当前任务仍在执行，完成后不会自动继续）'
      : '状态：未启动（在 Web 转写页点「开始队列」）');
  }
  if (snapshot.error) console.log(`错误：${snapshot.error}`);

  const items = snapshot.items ?? [];
  const rows = has(args, '--all') ? items : items.filter((item) => item.status !== 'done');
  if (rows.length === 0) {
    console.log('没有待处理的队列项');
    return;
  }
  const shown = has(args, '--all') ? rows : rows.slice(0, 20);
  if (has(args, '--json')) {
    print(shown);
    return;
  }
  console.log('状态\t进度\t节目\t单集\t任务');
  for (const item of shown) {
    console.log([
      item.status,
      `${item.progress ?? 0}%`,
      (item.show_title ?? item.show_id ?? '—').slice(0, 16),
      String(item.title ?? '').slice(0, 40),
      item.task_id ?? '—',
    ].join('\t'));
  }
  if (!has(args, '--all') && rows.length > shown.length) {
    console.log(`\n还有 ${rows.length - shown.length} 条待处理；yuxun ps --all 查看全部`);
  }
}

async function psCommand(args: string[]): Promise<void> {
  const server = await resolveServer(option(args, '--server'));
  const token = await authenticated(server);
  if (!has(args, '--tasks')) {
    try {
      const snapshot = (await request(server, '/api/v1/queue', { token })).data as QueueSnapshot;
      printQueue(snapshot, args);
      return;
    } catch {
      // 旧服务端没有队列接口时回退到平台任务。
    }
  }
  const result = await request(server, '/v1/tasks?limit=100', { token });
  const tasks = (result.data as { tasks: TaskRow[] }).tasks ?? [];
  const active = tasks.filter((task) => ['queued', 'running', 'recovering'].includes(task.status));
  const rows = has(args, '--all') ? tasks.slice(0, 30) : active;
  if (rows.length === 0) {
    console.log('没有进行中的任务');
    return;
  }
  if (has(args, '--json')) {
    print(rows);
    return;
  }
  for (const task of rows) {
    const title = task.input?.title ?? task.input?.show_id ?? '';
    console.log(`${task.status}\t${task.progress ?? 0}%\t${task.app_id}/${task.task_key}\t${String(title).slice(0, 40)}\t${task.task_id}`);
  }
  if (!has(args, '--all')) console.log('\n结束任务：yuxun stop <task-id>');
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
    console.log(usage(args.includes('--all')));
    return;
  }

  if (args[0] === 'logout') {
    await rm(sessionPath(), { force: true });
    console.log('已删除本机登录凭据');
    return;
  }

  if (args[0] === 'version') {
    console.log(`yuxun ${await readVersion()}`);
    console.log(`runtime: ${ROOT}`);
    return;
  }

  if (args[0] === 'doctor') {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'mac-agent.ts'), 'doctor'], {
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
    return;
  }

  if (args[0] === 'worker') {
    if (args.length === 1 || args[1] === '--help' || args[1] === '-h') {
      console.log(groupUsage('worker'));
      return;
    }
    const command = args[1] as string;
    if (command === 'run') {
      const { runTranscriptionWorker } = await import('./transcription/worker.ts');
      await runTranscriptionWorker();
      return;
    }
    const result = spawnSync(process.execPath,
      [join(ROOT, 'scripts', 'mac-agent.ts'), command, ...args.slice(2)], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
    return;
  }

  if (args[0] === 'mac') {
    console.warn('yuxun mac 是兼容别名，请改用 yuxun worker');
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'mac-agent.ts'), ...args.slice(1)], {
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
    return;
  }

  const explicitServer = option(args, '--server');

  if (args[0] === 'status') {
    await statusCommand(args);
    return;
  }

  if (args[0] === 'stop' && !args[1]) {
    console.log('用法：yuxun stop <task-id>');
    return;
  }

  if (args[1] === '--help' || args[1] === '-h') {
    console.log(groupUsage(args[0]));
    return;
  }

  if (['task', 'schedule', 'app', 'artifact'].includes(args[0]) && args.length === 1) {
    console.log(groupUsage(args[0]));
    return;
  }

  if (args[0] === 'login') {
    const server = await resolveServer(explicitServer);
    const username = option(args, '--username')
      ?? envValue('YUXUN_OWNER_USERNAME', 'TASKBASE_OWNER_USERNAME', 'owner') as string;
    const password = await promptPassword();
    const result = await request(server, '/v1/auth/login', { method: 'POST', body: { username, password } });
    const token = (result.data as { token: string }).token;
    await writeSession({ server, token });
    console.log(`已登录 ${server}`);
    return;
  }

  const server = await resolveServer(explicitServer);
  const token = await authenticated(server);

  if (args[0] === 'ps') {
    await psCommand(args);
    return;
  }

  if (args[0] === 'stop' && args[1]) {
    const reason = option(args, '--reason') ?? 'manual stop';
    print((await request(server, `/v1/tasks/${encodeURIComponent(args[1])}/close`, {
      method: 'POST', token, body: { reason },
    })).data);
    return;
  }

  if (args[0] === 'transcribe') {
    const audioUrl = args[1];
    if (!audioUrl || audioUrl.startsWith('--')) throw new Error('缺少音频 URL');
    let parsed: URL;
    try { parsed = new URL(audioUrl); } catch { throw new Error('音频 URL 无效'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('音频 URL 必须是 http(s)');
    }
    const input: Record<string, unknown> = { audio_url: parsed.toString() };
    const title = option(args, '--title');
    const language = option(args, '--language');
    const episodeId = option(args, '--episode-id');
    const showId = option(args, '--show-id');
    if (title) input.title = title;
    if (language) input.language = language;
    if (episodeId) input.episode_id = episodeId;
    if (showId) input.show_id = showId;
    const headers: Record<string, string> = {};
    const idempotencyKey = option(args, '--idempotency-key');
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetch(new URL('/v1/tasks', server), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ task: 'transcription-tools/episode/transcribe', input }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = JSON.parse(await response.text()) as unknown;
    if (!response.ok) throw new Error(JSON.stringify(data));
    print(data);
    const taskId = (data as { task: { task_id: string } }).task.task_id;
    if (has(args, '--no-wait')) return;
    const rawTimeout = option(args, '--timeout');
    const timeout = rawTimeout === undefined ? 21_600 : Number(rawTimeout);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400) {
      throw new Error('--timeout 必须是 1–86400 秒的整数');
    }
    const result = await waitTask(server, token, taskId, timeout) as {
      status?: string; artifact_id?: string | null; output?: { artifact_id?: string } | null;
    };
    if (result.status !== 'succeeded') return;
    const artifactId = result.artifact_id ?? result.output?.artifact_id;
    if (!artifactId) throw new Error('任务成功但没有产物 artifact_id');
    const out = option(args, '--out') ?? `transcript-${taskId.slice(0, 8)}.md`;
    const target = resolve(out);
    const artifact = await fetch(new URL(`/v1/artifacts/${encodeURIComponent(artifactId)}/download`, server), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!artifact.ok) throw new Error(await artifact.text());
    await writeFile(target, Buffer.from(await artifact.arrayBuffer()), { flag: 'wx', mode: 0o600 });
    console.log(`转写稿已保存到 ${target}`);
    return;
  }

  if (args[0] === 'apps' && (args[1] === undefined || args[1] === 'list')) {
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
