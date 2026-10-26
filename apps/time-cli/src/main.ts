/**
 * 独立时间查询 CLI。服务器地址和用户 Token 存在本机配置目录；
 * 查询时只调用 HTTP API，时间由服务器侧 Worker 生成。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Config = { server: string };
type TaskResponse = {
  task_id: string;
  status: string;
  output: unknown;
  error: string | null;
};

const configDir = resolve(process.env.TIME_CLI_DIR ?? '.local/time-cli');
const configFile = resolve(configDir, 'config.json');
const tokenFile = resolve(configDir, 'token');

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** HTTP 只允许本机回环地址；访问其他服务器时要求 HTTPS。 */
function normalizeServer(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('本机可使用 HTTP；其他服务器地址必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务器地址应为根地址，例如 http://127.0.0.1:3333');
  }
  return url.origin;
}

async function readConfig(): Promise<Config> {
  try {
    const value = JSON.parse(await readFile(configFile, 'utf8')) as Config;
    return { server: normalizeServer(value.server) };
  } catch {
    throw new Error('尚未配置服务器地址，请先运行 time-cli config set-server <地址>');
  }
}

async function readToken(server: string): Promise<string> {
  if (process.env.TIME_CLI_TOKEN) return process.env.TIME_CLI_TOKEN;
  let content: string;
  try { content = await readFile(tokenFile, 'utf8'); }
  catch { throw new Error('尚未登录，请先运行 time-cli login'); }
  let saved: { server: string; token: string };
  try {
    saved = JSON.parse(content) as { server: string; token: string };
  } catch { throw new Error('凭据文件无效，请重新登录'); }
  if (saved.server !== server) throw new Error('服务器地址已更改，请重新登录');
  if (typeof saved.token !== 'string' || saved.token.length === 0) throw new Error('凭据文件无效，请重新登录');
  return saved.token;
}

async function promptPassword(): Promise<string> {
  if (process.env.TIME_CLI_PASSWORD) return process.env.TIME_CLI_PASSWORD;
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('非交互环境请设置 TIME_CLI_PASSWORD');
  }
  return new Promise((resolvePassword, reject) => {
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
        if (byte === 13 || byte === 10) return finish();
        if (byte === 3) return finish(new Error('已取消登录'));
        if (byte === 127 || byte === 8) {
          let removed = bytes.pop();
          while (removed !== undefined && (removed & 0xc0) === 0x80) removed = bytes.pop();
        } else bytes.push(byte);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function api<T>(server: string, path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, `${server}/`), {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = data.error as { code?: string; message?: string } | undefined;
    throw new Error(`${error?.code ?? response.status}: ${error?.message ?? '服务器请求失败'}`);
  }
  return data as T;
}

function timeOutput(value: unknown): { server_time: string; timezone: 'UTC' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('服务器返回的时间结果格式无效');
  }
  const result = value as Record<string, unknown>;
  if (typeof result.server_time !== 'string' || Number.isNaN(Date.parse(result.server_time)) ||
    result.timezone !== 'UTC') {
    throw new Error('服务器返回的时间结果格式无效');
  }
  return { server_time: result.server_time, timezone: 'UTC' };
}

async function waitForTask(server: string, token: string, taskId: string, timeoutMs: number): Promise<TaskResponse> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const task = await api<TaskResponse>(server, `/v1/tasks/${encodeURIComponent(taskId)}`, token);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed') throw new Error(`任务 ${taskId} 失败：${task.error ?? '未知错误'}`);
    if (Date.now() >= deadline) {
      throw new Error(`等待任务 ${taskId} 超时；可稍后使用 time-cli task get ${taskId} 查询`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}

function usage(): never {
  throw new Error(`用法:
  time-cli config set-server <http://127.0.0.1:3333 或 HTTPS 地址>
  time-cli config show
  time-cli login [--username owner]
  time-cli query time [--server 地址] [--timeout 秒] [--json]
  time-cli task get <task-id> [--server 地址]`);
}

/** 解析 CLI 命令；导出给集成测试，运行时只需执行脚本入口。 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === 'config' && args[1] === 'set-server' && args[2]) {
    const server = normalizeServer(args[2]);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(configFile, `${JSON.stringify({ server }, null, 2)}\n`, { mode: 0o600 });
    await chmod(configFile, 0o600);
    console.log(`服务器地址已设置为 ${server}`);
    return;
  }
  if (args[0] === 'config' && args[1] === 'show') {
    console.log((await readConfig()).server);
    return;
  }
  const server = flag(args, '--server') ? normalizeServer(flag(args, '--server') as string) : (await readConfig()).server;
  if (args[0] === 'login') {
    const username = flag(args, '--username') ?? 'owner';
    const password = await promptPassword();
    const result = await api<{ token: string }>(server, '/v1/auth/cli-token', null, {
      method: 'POST', body: JSON.stringify({ username, password }),
    });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, JSON.stringify({ server, token: result.token }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    console.log('登录成功');
    return;
  }
  if (args[0] === 'query' && args[1] === 'time') {
    const token = await readToken(server);
    const timeoutSeconds = Number(flag(args, '--timeout') ?? 60);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      throw new Error('--timeout 必须是 1 至 3600 秒的整数');
    }
    const submitted = await api<{ task: { task_id: string } }>(server, '/v1/tasks', token, {
      method: 'POST', body: JSON.stringify({ task: 'time-service/time/now', input: {} }),
    });
    const task = await waitForTask(server, token, submitted.task.task_id, timeoutSeconds * 1000);
    const output = timeOutput(task.output);
    if (args.includes('--json')) console.log(JSON.stringify({ task_id: task.task_id, ...output }));
    else console.log(`服务器时间 (UTC): ${output.server_time}`);
    return;
  }
  if (args[0] === 'task' && args[1] === 'get' && args[2]) {
    const task = await api<TaskResponse>(server, `/v1/tasks/${encodeURIComponent(args[2])}`, await readToken(server));
    console.log(JSON.stringify(task, null, 2));
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
