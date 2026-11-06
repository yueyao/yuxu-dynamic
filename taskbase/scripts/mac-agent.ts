#!/usr/bin/env node
/**
 * Mac 端 Taskbase Agent 控制程序。
 * 它把远端 Taskbase 和 Mac 本地 Transcription Worker 配对起来。
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.taskbase.mac-agent';
const DEFAULT_MODEL = 'small';

type AgentConfig = {
  server: string;
  model: string;
  data_dir: string;
  installed_at: string;
  node: string;
};

function agentDir(): string {
  return resolve(process.env.TASKBASE_MAC_AGENT_DIR ?? join(homedir(), '.config', 'taskbase'));
}
function envPath(): string { return join(agentDir(), 'mac-agent.env'); }
function configPath(): string { return join(agentDir(), 'mac-agent.json'); }
function launchAgentsDir(): string {
  return resolve(process.env.TASKBASE_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents'));
}
function plistPath(): string { return join(launchAgentsDir(), `${LABEL}.plist`); }
function logPath(): string {
  return resolve(process.env.TASKBASE_MAC_AGENT_LOG ?? join(homedir(), 'Library', 'Logs', 'taskbase-agent.log'));
}

/** DSH/Electron 里 process.execPath 可能是 Helper；优先找真正的 node。 */
function nodeBinary(): string {
  const candidates = [
    process.env.TASKBASE_NODE_BIN,
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync('/usr/bin/which', ['node'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return process.execPath;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
  return value;
}
function has(args: string[], name: string): boolean { return args.includes(name); }

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function readConfig(): Promise<AgentConfig | null> {
  try {
    const value = JSON.parse(await readFile(configPath(), 'utf8')) as AgentConfig;
    return value.server && value.data_dir ? value : null;
  } catch { return null; }
}

function quiet(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (error) => resolveRun({ ok: false, output: error.message }));
    child.on('close', (code) => resolveRun({ ok: code === 0, output }));
  });
}

async function health(server: string): Promise<{ ok: boolean; detail: string }> {
  let last = '';
  for (const path of ['/health', '/api/health']) {
    try {
      const response = await fetch(new URL(path, server), { signal: AbortSignal.timeout(8_000) });
      const detail = `${path} ${response.status} ${(await response.text()).slice(0, 100)}`;
      if (response.ok) return { ok: true, detail };
      last = detail;
    } catch (error) {
      last = `${path} ${(error as Error).message}`;
    }
  }
  return { ok: false, detail: last };
}

function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (error) => resolveRun({ ok: false, output: error.message }));
    child.on('close', (code) => resolveRun({ ok: code === 0, output }));
  });
}

function serviceTarget(): string {
  return `gui/${process.getuid?.() ?? 501}/${LABEL}`;
}

function envFile(server: string, token: string, dataDir: string, model: string): string {
  return [
    `TASKBASE_URL=${server}`,
    `TASKBASE_WORKER_TOKEN=${token}`,
    `TASKBASE_DATA_DIR=${dataDir}`,
    `TRANSCRIPTION_WHISPER_MODEL=${model}`,
    'TASKBASE_POLL_MS=2000',
    'TASKBASE_HEARTBEAT_MS=15000',
    '',
  ].join('\n');
}

async function pair(args: string[]): Promise<void> {
  const server = (option(args, '--server') ?? process.env.TASKBASE_URL ?? '').replace(/\/+$/, '');
  const token = option(args, '--token') ?? process.env.TASKBASE_WORKER_TOKEN
    ?? (existsSync(envPath()) ? (await readFile(envPath(), 'utf8')).match(/^TASKBASE_WORKER_TOKEN=(.*)$/m)?.[1] : undefined);
  if (!server) throw new Error('缺少 --server，例如 http://43.156.253.152');
  if (!token) throw new Error('缺少 --token（Transcription Worker Token）');
  const parsed = new URL(server);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--server 必须是 http(s)');
  const model = option(args, '--model') ?? process.env.TRANSCRIPTION_WHISPER_MODEL ?? DEFAULT_MODEL;
  const dataDir = resolve(option(args, '--data-dir') ?? join(homedir(), 'Library', 'Application Support', 'TaskbaseAgent'));
  await mkdir(agentDir(), { recursive: true, mode: 0o700 });
  await chmod(agentDir(), 0o700);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(envPath(), envFile(server, token, dataDir, model), { mode: 0o600 });
  await chmod(envPath(), 0o600);
  const config: AgentConfig = {
    server, model, data_dir: dataDir,
    installed_at: new Date().toISOString(),
    node: nodeBinary(),
  };
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath(), 0o600);
  const result = await health(server);
  console.log(`已配对：${server}`);
  console.log(`服务端健康：${result.ok ? '正常' : `失败（${result.detail}）`}`);
  console.log(`模型：whisper/${model}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`环境文件：${envPath()}`);
  console.log('下一步：npm run mac:doctor && npm run mac:install');
}

async function doctor(): Promise<void> {
  const config = await readConfig();
  const checks: Array<[string, boolean, string]> = [];
  checks.push(['配置文件', Boolean(config), config ? configPath() : `缺少 ${configPath()}`]);
  const env = existsSync(envPath()) ? await readFile(envPath(), 'utf8') : '';
  checks.push(['Worker Token', /^TASKBASE_WORKER_TOKEN=.+/m.test(env), envPath()]);
  const ffmpeg = await quiet('ffmpeg', ['-version']);
  checks.push(['ffmpeg', ffmpeg.ok, ffmpeg.ok ? ffmpeg.output.split('\n')[0] : '未安装或不在 PATH']);
  const whisper = await quiet(process.env.TRANSCRIPTION_WHISPER_BIN ?? 'whisper', ['--help']);
  checks.push(['whisper CLI', whisper.ok, whisper.ok ? '可用' : '未安装或不在 PATH']);
  if (config) {
    const server = await health(config.server);
    checks.push(['服务端 /health', server.ok, `${config.server} ${server.detail}`]);
    checks.push(['数据目录', existsSync(config.data_dir), config.data_dir]);
  }
  for (const [name, ok, detail] of checks) console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function install(): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error('尚未配对，请先运行 npm run mac:pair');
  if (!existsSync(envPath())) throw new Error(`缺少环境文件 ${envPath()}`);
  await mkdir(launchAgentsDir(), { recursive: true });
  await mkdir(dirname(logPath()), { recursive: true });
  const worker = join(ROOT, 'src', 'transcription', 'worker.ts');
  if (!existsSync(worker)) throw new Error(`找不到 Worker：${worker}`);
  const pathValue = [
    dirname(nodeBinary()), '/usr/local/bin', '/opt/homebrew/bin',
    '/Library/Frameworks/Python.framework/Versions/3.13/bin', '/usr/bin', '/bin',
  ].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBinary())}</string>
    <string>--env-file=${xml(envPath())}</string>
    <string>${xml(worker)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath())}</string>
  <key>StandardErrorPath</key><string>${xml(logPath())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathValue)}</string>
  </dict>
</dict>
</plist>
`;
  await writeFile(plistPath(), plist, { mode: 0o600 });
  await chmod(plistPath(), 0o600);
  await launchctl(['bootout', serviceTarget()]);
  const boot = await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()]);
  if (!boot.ok) throw new Error(`launchctl bootstrap 失败：${boot.output}`);
  await launchctl(['kickstart', '-k', serviceTarget()]);
  console.log(`已安装 LaunchAgent：${plistPath()}`);
  console.log(`日志：${logPath()}`);
  console.log('状态：npm run mac:status');
}

async function start(): Promise<void> {
  if (!existsSync(plistPath())) throw new Error('尚未安装 LaunchAgent，请先运行 npm run mac:install');
  const result = await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()]);
  if (!result.ok && !result.output.includes('already bootstrapped')) {
    throw new Error(result.output || 'launchctl bootstrap 失败');
  }
  await launchctl(['kickstart', '-k', serviceTarget()]);
  console.log('Mac Agent 已启动');
}

async function stop(): Promise<void> {
  const result = await launchctl(['bootout', serviceTarget()]);
  console.log(result.ok ? 'Mac Agent 已停止' : `停止失败：${result.output}`);
  if (!result.ok) process.exitCode = 1;
}

async function status(): Promise<void> {
  const config = await readConfig();
  console.log(`服务端：${config?.server ?? '未配对'}`);
  console.log(`模型：${config?.model ?? '未设置'}`);
  console.log(`环境：${envPath()}`);
  console.log(`LaunchAgent：${plistPath()}`);
  const result = await launchctl(['print', serviceTarget()]);
  console.log(result.ok ? result.output : 'LaunchAgent 未安装或未运行');
  if (!result.ok) process.exitCode = 1;
}

async function logs(): Promise<void> {
  if (!existsSync(logPath())) {
    console.log(`日志文件不存在：${logPath()}`);
    return;
  }
  await new Promise<void>((done) => {
    const child = spawn('/usr/bin/tail', ['-n', '80', '-f', logPath()], { stdio: 'inherit' });
    child.on('close', () => done());
  });
}

async function run(): Promise<void> {
  if (!existsSync(envPath())) throw new Error('尚未配对，请先运行 npm run mac:pair');
  const worker = join(ROOT, 'src', 'transcription', 'worker.ts');
  await new Promise<void>((done, reject) => {
    const child = spawn(nodeBinary(), [`--env-file=${envPath()}`, worker], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? done() : reject(new Error(`Worker 退出码 ${code}`)));
  });
}

async function uninstall(args: string[]): Promise<void> {
  await launchctl(['bootout', serviceTarget()]);
  await rm(plistPath(), { force: true });
  if (has(args, '--purge')) {
    await rm(envPath(), { force: true });
    await rm(configPath(), { force: true });
  }
  console.log('已卸载 LaunchAgent');
}

function usage(): string {
  return `用法:
  npm run mac:pair -- --server <URL> --token <Worker Token> [--model small] [--data-dir <path>]
  npm run mac:doctor
  npm run mac:install
  npm run mac:start | mac:stop | mac:status | mac:logs
  npm run mac:run
  npm run mac:uninstall [-- --purge]

说明：
  - 本工具只控制 Mac 上的 Transcription Worker；任务仍在远端 Platform。
  - 环境变量可覆盖目录：TASKBASE_MAC_AGENT_DIR、TASKBASE_LAUNCH_AGENTS_DIR、TASKBASE_MAC_AGENT_LOG。`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') { console.log(usage()); return; }
  if (command === 'pair') return pair(args);
  if (command === 'doctor') return doctor();
  if (command === 'install') return install();
  if (command === 'start') return start();
  if (command === 'stop') return stop();
  if (command === 'status') return status();
  if (command === 'logs') return logs();
  if (command === 'run') return run();
  if (command === 'uninstall') return uninstall(args);
  throw new Error(usage());
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
