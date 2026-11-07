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

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] && !args[index + 1].startsWith('--')) {
      values.push(args[index + 1]);
    }
  }
  return values;
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
  yuxun ps                        查看进行中的任务
  yuxun transcribe <audio-url>    提交音频转写并保存 Markdown
  yuxun stop <task-id>            结束任务
  yuxun batch                     批量转写：预览队列，--yes 开始
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
    case 'batch':
      return `批量转写:
  yuxun batch [--show <节目名|ID>] [--limit N] [--order newest|oldest|shortest|longest|given]
              [--since YYYY-MM-DD] [--until YYYY-MM-DD]
              [--episode <id>] [--exclude <id>] [--include-done]
              [--dry-run] [--yes]
  默认只预览；加 --yes 才会提交。Ctrl-C 在当前一集完成后停止。`;
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
  input?: { title?: string; audio_url?: string; show_id?: string; episode_id?: string } | null;
};

async function psCommand(args: string[]): Promise<void> {
  const server = await resolveServer(option(args, '--server'));
  const token = await authenticated(server);
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

type BatchEpisode = {
  episode_id: string;
  show_id: string;
  show_title: string;
  title: string;
  duration_seconds: number | null;
  published_at: string | null;
  audio_url: string;
};

type BatchOrder = 'newest' | 'oldest' | 'shortest' | 'longest' | 'given';

const BATCH_ORDERS: BatchOrder[] = ['newest', 'oldest', 'shortest', 'longest', 'given'];

async function webLogin(server: string, username: string, password: string): Promise<string> {
  const response = await fetch(new URL('/api/login', server), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Web 登录失败：${text.slice(0, 200)}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('Web 登录没有返回会话 Cookie');
  return cookie;
}

async function webGet(server: string, cookie: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, server), {
    headers: { cookie },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Web API ${path} 失败：${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function batchDate(value: string, endOfDay: boolean): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期格式应为 YYYY-MM-DD：${value}`);
  const time = Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (!Number.isFinite(time)) throw new Error(`日期无效：${value}`);
  return time;
}

function batchDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '-';
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function sortBatch(episodes: BatchEpisode[], order: BatchOrder): BatchEpisode[] {
  const time = (episode: BatchEpisode) => episode.published_at ? Date.parse(episode.published_at) : 0;
  const duration = (episode: BatchEpisode) => episode.duration_seconds ?? 0;
  if (order === 'given') return [...episodes];
  return [...episodes].sort((left, right) => {
    if (order === 'shortest') return duration(left) - duration(right);
    if (order === 'longest') return duration(right) - duration(left);
    return order === 'oldest' ? time(left) - time(right) : time(right) - time(left);
  });
}

async function doneEpisodeIds(server: string, token: string): Promise<Set<string>> {
  const done = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ app_id: 'transcription-tools', status: 'succeeded', limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const data = (await request(server, `/v1/tasks?${query}`, { token })).data as
      { tasks: TaskRow[]; next_cursor?: string | null };
    for (const task of data.tasks ?? []) {
      if (task.input?.episode_id) done.add(task.input.episode_id);
    }
    cursor = data.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return done;
}

async function collectBatch(server: string, cookie: string, args: string[], doneIds: Set<string>): Promise<{
  selected: BatchEpisode[];
  skippedDone: number;
  totalEpisodes: number;
  showCount: number;
}> {
  const showsData = await webGet(server, cookie, '/api/podcast/shows');
  let shows = (showsData.shows ?? []) as Array<{ show_id: string; title: string }>;
  const showFilters = options(args, '--show');
  if (showFilters.length > 0) {
    shows = shows.filter((show) => showFilters.some((filter) =>
      filter === show.show_id || show.title.includes(filter)));
  }
  if (shows.length === 0) throw new Error('没有匹配的节目');

  const lists = await Promise.all(shows.map((show) => webGet(server, cookie,
    `/api/podcast/shows/${encodeURIComponent(show.show_id)}/episodes?limit=500`)));
  const episodes: BatchEpisode[] = [];
  lists.forEach((data, index) => {
    const show = shows[index];
    for (const raw of (data.episodes ?? []) as Array<Record<string, unknown>>) {
      if (typeof raw.audio_url !== 'string' || !raw.audio_url) continue;
      episodes.push({
        episode_id: String(raw.episode_id),
        show_id: show.show_id,
        show_title: show.title,
        title: String(raw.title ?? ''),
        duration_seconds: typeof raw.duration_seconds === 'number' ? raw.duration_seconds : null,
        published_at: typeof raw.published_at === 'string' ? raw.published_at : null,
        audio_url: raw.audio_url,
      });
    }
  });

  const since = option(args, '--since');
  const until = option(args, '--until');
  const sinceTime = since ? batchDate(since, false) : null;
  const untilTime = until ? batchDate(until, true) : null;
  const onlyIds = new Set(options(args, '--episode'));
  const excluded = new Set(options(args, '--exclude'));

  let candidates = episodes.filter((episode) => {
    if (onlyIds.size > 0 && !onlyIds.has(episode.episode_id)) return false;
    if (excluded.has(episode.episode_id)) return false;
    if (sinceTime !== null) {
      const published = episode.published_at ? Date.parse(episode.published_at) : 0;
      if (published < sinceTime) return false;
    }
    if (untilTime !== null) {
      const published = episode.published_at ? Date.parse(episode.published_at) : 0;
      if (published > untilTime) return false;
    }
    return true;
  });

  let skippedDone = 0;
  if (!has(args, '--include-done')) {
    const before = candidates.length;
    candidates = candidates.filter((episode) => !doneIds.has(episode.episode_id));
    skippedDone = before - candidates.length;
  }

  const order = (option(args, '--order') ?? 'newest') as BatchOrder;
  if (!BATCH_ORDERS.includes(order)) throw new Error(`--order 只支持 ${BATCH_ORDERS.join(' / ')}`);
  if (order === 'given' && onlyIds.size > 0) {
    const position = new Map(options(args, '--episode').map((id, index) => [id, index]));
    candidates = [...candidates].sort((left, right) =>
      (position.get(left.episode_id) ?? 0) - (position.get(right.episode_id) ?? 0));
  } else {
    candidates = sortBatch(candidates, order);
  }

  const rawLimit = option(args, '--limit');
  if (rawLimit !== undefined) {
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数');
    candidates = candidates.slice(0, limit);
  }

  return { selected: candidates, skippedDone, totalEpisodes: episodes.length, showCount: shows.length };
}

async function submitBatchTask(server: string, token: string, episode: BatchEpisode): Promise<string> {
  const response = await fetch(new URL('/v1/tasks', server), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `batch-${episode.episode_id}`,
    },
    body: JSON.stringify({
      task: 'transcription-tools/episode/transcribe',
      input: {
        audio_url: episode.audio_url,
        episode_id: episode.episode_id,
        show_id: episode.show_id,
        title: episode.title,
        language: 'zh',
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`提交失败：${text.slice(0, 300)}`);
  return (JSON.parse(text) as { task: { task_id: string } }).task.task_id;
}

async function waitBatchTask(server: string, token: string, taskId: string): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastProgress = -1;
  while (true) {
    const task = (await request(server, `/v1/tasks/${encodeURIComponent(taskId)}`, { token })).data as
      Record<string, unknown>;
    const progress = typeof task.progress === 'number' ? task.progress : 0;
    if (progress !== lastProgress) {
      lastProgress = progress;
      console.log(`  ${String(task.status)} ${progress}%`);
    }
    if (['succeeded', 'failed', 'closed'].includes(String(task.status))) return task;
    if (Date.now() - startedAt > 6 * 60 * 60 * 1000) {
      await request(server, `/v1/tasks/${encodeURIComponent(taskId)}/close`,
        { method: 'POST', token, body: { reason: 'batch timeout' } }).catch(() => {});
      throw new Error('任务超过 6 小时，已关闭');
    }
    await new Promise((done) => setTimeout(done, 5_000));
  }
}

async function batchCommand(args: string[], server: string, token: string): Promise<void> {
  const username = option(args, '--username')
    ?? envValue('YUXUN_OWNER_USERNAME', 'TASKBASE_OWNER_USERNAME', 'owner') as string;
  const password = process.env.YUXUN_PASSWORD ?? process.env.TASKBASE_PASSWORD ?? await promptPassword();
  const cookie = await webLogin(server, username, password);
  const doneIds = await doneEpisodeIds(server, token);
  const { selected, skippedDone, totalEpisodes, showCount } = await collectBatch(server, cookie, args, doneIds);
  const order = option(args, '--order') ?? 'newest';

  console.log(`节目 ${showCount} 个，可转写单集 ${totalEpisodes} 集，已转写跳过 ${skippedDone} 集`);
  if (selected.length === 0) {
    console.log('没有需要转写的单集');
    return;
  }
  console.log(`本次计划 ${selected.length} 集，顺序 ${order}`);
  for (const [index, episode] of selected.slice(0, 10).entries()) {
    console.log(`  ${index + 1}. [${episode.show_title}] ${episode.title.slice(0, 50)}  ${batchDuration(episode.duration_seconds)}`);
  }
  if (selected.length > 10) console.log(`  ... 其余 ${selected.length - 10} 集`);
  if (!has(args, '--yes') || has(args, '--dry-run')) {
    console.log('\n这是预览；加 --yes 开始执行');
    return;
  }

  let stopped = false;
  const onInterrupt = () => {
    stopped = true;
    console.log('\n收到 Ctrl-C：当前任务完成后停止');
  };
  process.on('SIGINT', onInterrupt);

  let succeeded = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  for (const [index, episode] of selected.entries()) {
    if (stopped) break;
    console.log(`\n[${index + 1}/${selected.length}] [${episode.show_title}] ${episode.title}`);
    try {
      const taskId = await submitBatchTask(server, token, episode);
      const task = await waitBatchTask(server, token, taskId);
      if (task.status === 'succeeded') {
        succeeded += 1;
        consecutiveFailures = 0;
      } else {
        failed += 1;
        consecutiveFailures += 1;
        console.log(`  失败：${String(task.error ?? task.status)}`);
        if (consecutiveFailures >= 3) {
          console.log('连续失败 3 次，停止批量任务');
          break;
        }
      }
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      console.log(`  错误：${(error as Error).message}`);
      if (consecutiveFailures >= 3) {
        console.log('连续失败 3 次，停止批量任务');
        break;
      }
    }
  }
  process.off('SIGINT', onInterrupt);
  console.log(`\n批量结束：成功 ${succeeded} 集，失败 ${failed} 集`);
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

  if (args[0] === 'batch') {
    await batchCommand(args, server, token);
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
