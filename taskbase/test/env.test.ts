import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'new-test-password-1234';

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:YUXUN_|TASKBASE_)/.test(key))), ...extra };
}

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: ROOT, env: cleanEnv(env), timeout: 6000 },
      (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout));
  });
}

async function waitFor(check: () => boolean, child?: ChildProcess, output = () => ''): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(output());
    if (Date.now() >= deadline) throw new Error(`等待进程就绪超时: ${output()}`);
    await delay(25);
  }
}

function start(t: TestContext, script: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const done = new Promise<void>((resolve) => child.on('close', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      try { await done; } finally { clearTimeout(timer); }
    } else await done;
  });
  return { child, output: () => output };
}

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('bootstrap：新变量可独立使用，冲突时新别名优先，旧别名仍可初始化', async (t) => {
  const dir = await temp(t);
  for (const mode of ['new', 'conflict', 'legacy']) {
    const data = join(dir, mode);
    const env = mode === 'legacy'
      ? { TASKBASE_DATA_DIR: data, TASKBASE_OWNER_USERNAME: 'legacy-owner', TASKBASE_OWNER_PASSWORD: PASSWORD }
      : { YUXUN_DATA_DIR: data, YUXUN_OWNER_USERNAME: 'new-owner', YUXUN_OWNER_PASSWORD: PASSWORD,
        ...(mode === 'conflict' ? { TASKBASE_OWNER_USERNAME: 'wrong-owner', TASKBASE_OWNER_PASSWORD: 'wrong-password-123' } : {}) };
    await run(['src/bootstrap.ts'], env);
    const store = new Store(join(data, 'taskbase.sqlite'));
    try { assert.ok(store.login(mode === 'legacy' ? 'legacy-owner' : 'new-owner', PASSWORD)); }
    finally { store.closeDb(); }
  }
});

for (const entry of [{ script: 'src/main.ts', prefix: '', ready: 'Taskbase API:' },
  { script: 'web/main.ts', prefix: 'WEB_', ready: 'Taskbase Web:' }]) {
  test(`${entry.script}：使用已验证的新别名端口，旧端口不能覆盖`, async (t) => {
    const dir = await temp(t);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const process = start(t, entry.script, { YUXUN_DATA_DIR: dir,
      [`YUXUN_${entry.prefix}PORT`]: String(port), [`TASKBASE_${entry.prefix}PORT`]: 'invalid-old-port' });
    await waitFor(() => process.output().includes(entry.ready), process.child, process.output);
    const response = await fetch(`http://127.0.0.1:${port}/${entry.prefix ? '' : 'health'}`);
    assert.equal(response.status, 200);
  });
}

for (const script of ['src/podcast/worker.ts', 'src/transcription/worker.ts', 'src/worker-demo.ts']) {
  test(`${script}：URL/Token 使用新别名，并在启动前拒绝无效轮询或心跳`, async (t) => {
    const dir = await temp(t);
    const tokens: string[] = [];
    const url = await listen(t, createServer((request, response) => {
      tokens.push(request.headers.authorization ?? ''); response.writeHead(204); response.end();
    }));
    const env = { YUXUN_DATA_DIR: dir, YUXUN_URL: url, TASKBASE_URL: 'http://127.0.0.1:1',
      YUXUN_WORKER_TOKEN: 'new-worker-test-token', TASKBASE_WORKER_TOKEN: 'old-worker-test-token',
      YUXUN_POLL_MS: '100', TASKBASE_POLL_MS: '-1', YUXUN_HEARTBEAT_MS: '1000', TASKBASE_HEARTBEAT_MS: '-1' };
    const process = start(t, script, env);
    await waitFor(() => tokens.length > 0, process.child, process.output);
    assert.equal(tokens[0], 'Bearer new-worker-test-token');
    for (const name of ['YUXUN_POLL_MS', 'YUXUN_HEARTBEAT_MS']) {
      await assert.rejects(run([script], { ...env, [name]: '-1' }), /必须是正整数/);
    }
  });
}

test('Web：新别名 Owner 凭据恢复队列，只读 Token 使用新别名', async (t) => {
  const dir = await temp(t);
  const queue = new TranscriptionQueueStore(join(dir, 'taskbase.sqlite'));
  queue.add([{ episode_id: 'episode', show_id: 'show', title: 'Episode', audio_url: 'https://example.com/audio.mp3' }]);
  queue.setState('active', '1'); queue.close();
  let login: unknown;
  let submitted = false;
  const platformUrl = await listen(t, createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/auth/login') {
      login = JSON.parse(Buffer.concat(chunks).toString()); response.end(JSON.stringify({ token: 'service-test-token' }));
    } else if (request.url === '/v1/tasks') {
      submitted = request.headers.authorization === 'Bearer service-test-token';
      response.end(JSON.stringify({ task: { task_id: 'task', status: 'queued' } }));
    } else { response.writeHead(401); response.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'unauthorized' } })); }
  }));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const process = start(t, 'web/main.ts', { YUXUN_DATA_DIR: dir, YUXUN_WEB_PORT: String(port), YUXUN_URL: platformUrl,
    YUXUN_OWNER_USERNAME: 'new-owner', YUXUN_OWNER_PASSWORD: PASSWORD,
    TASKBASE_OWNER_USERNAME: 'old-owner', TASKBASE_OWNER_PASSWORD: 'old-password-1234',
    YUXUN_TRANSCRIPT_API_TOKEN: 'new-reader-token', TASKBASE_TRANSCRIPT_API_TOKEN: 'old-reader-token' });
  await waitFor(() => process.output().includes('Taskbase Web:'), process.child, process.output);
  const endpoint = `http://127.0.0.1:${port}/api/v1/queue`;
  assert.equal((await fetch(endpoint, { headers: { authorization: 'Bearer new-reader-token' } })).status, 200);
  assert.equal((await fetch(endpoint, { headers: { authorization: 'Bearer old-reader-token' } })).status, 401);
  await waitFor(() => submitted, process.child, process.output);
  assert.deepEqual(login, { username: 'new-owner', password: PASSWORD });
});

test('Mac pair：新别名 URL、Token、Node/目录以及显式参数优先级', async (t) => {
  const dir = await temp(t);
  const url = await listen(t, createServer((_request, response) => response.end('{}')));
  const env = { YUXUN_URL: url, YUXUN_WORKER_TOKEN: 'new-mac-test-token', TASKBASE_WORKER_TOKEN: 'old-mac-test-token',
    YUXUN_MAC_AGENT_DIR: join(dir, 'agent'), TASKBASE_MAC_AGENT_DIR: join(dir, 'wrong-agent'),
    YUXUN_LEGACY_AGENT_DIR: join(dir, 'legacy'), TASKBASE_LEGACY_AGENT_DIR: join(dir, 'legacy'),
    YUXUN_DATA_DIR: join(dir, 'data'), YUXUN_NODE_BIN: process.execPath, TASKBASE_NODE_BIN: '/bin/sh' };
  await run(['scripts/mac-agent.ts', 'pair', '--data-dir', join(dir, 'data')], env);
  let config = JSON.parse(await readFile(join(dir, 'agent/worker.json'), 'utf8'));
  assert.equal(config.server, url); assert.equal(config.node, process.execPath);
  assert.match(await readFile(join(dir, 'agent/worker.env'), 'utf8'), /YUXUN_WORKER_TOKEN=new-mac-test-token/);
  await appendFile(join(dir, 'agent/worker.env'),
    '\nTRANSCRIPTION_DIARIZATION_PYTHON="/tmp/isolated python/bin/python"\nTRANSCRIPTION_DIARIZATION_OFFLINE=1\nHF_TOKEN=hf_local_test_only\n');
  await run(['scripts/mac-agent.ts', 'pair', '--server', url, '--token', 'explicit-mac-test-token', '--data-dir', join(dir, 'explicit-data')],
    { ...env, YUXUN_URL: 'http://127.0.0.1:1' });
  config = JSON.parse(await readFile(join(dir, 'agent/worker.json'), 'utf8'));
  assert.equal(config.data_dir, join(dir, 'explicit-data'));
  assert.match(await readFile(join(dir, 'agent/worker.env'), 'utf8'), /YUXUN_WORKER_TOKEN=explicit-mac-test-token/);
  const repaired = await readFile(join(dir, 'agent/worker.env'), 'utf8');
  assert.match(repaired, /TRANSCRIPTION_DIARIZATION_PYTHON="\/tmp\/isolated python\/bin\/python"/);
  assert.match(repaired, /TRANSCRIPTION_DIARIZATION_OFFLINE=1/);
  assert.match(repaired, /HF_TOKEN=hf_local_test_only/);
  assert.doesNotMatch(repaired, /YUXUN_WORKER_TOKEN=new-mac-test-token/);
});

test('Mac doctor：MLX配置只检查指定Python，不要求标准Whisper CLI', async (t) => {
  const dir = await temp(t);
  const url = await listen(t, createServer((_request, response) => response.end('{}')));
  const python = join(dir, 'python.cjs');
  await writeFile(python, `#!/usr/bin/env node
const a=process.argv.slice(2);
if(!a.includes('--check')&&!a.includes('--resolve-only'))process.exit(2);
console.log(JSON.stringify({dependencies:true,inference_verified:false,revision:'fixed'}));`);
  await chmod(python, 0o755);
  const env = { YUXUN_MAC_AGENT_DIR: join(dir, 'agent'), YUXUN_LEGACY_AGENT_DIR: join(dir, 'legacy'),
    YUXUN_DATA_DIR: join(dir, 'data'), YUXUN_URL: url, YUXUN_WORKER_TOKEN: 'test-worker-token' };
  await run(['scripts/mac-agent.ts', 'pair'], env);
  await appendFile(join(dir, 'agent/worker.env'), `\nTRANSCRIPTION_WHISPER_BACKEND=mlx\nTRANSCRIPTION_MLX_PYTHON=${python}\nTRANSCRIPTION_WHISPER_BIN=/absent/whisper\nTRANSCRIPTION_DIARIZATION_PYTHON=${python}\n`);
  const output = await run(['scripts/mac-agent.ts', 'doctor'], env);
  assert.match(output, /✅ MLX Python依赖/);
  assert.doesNotMatch(output, /whisper CLI/);
  assert.match(output, /不代表真实推理已验收/);
});

test('CLI：新密码别名优先；空新值不使用旧密码；内联超限输入在联网前被拒绝', async (t) => {
  const dir = await temp(t);
  let login: unknown;
  let taskRequests = 0;
  const url = await listen(t, createServer(async (request, response) => {
    if (request.url === '/v1/auth/login') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      login = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify({ token: 'cli-test-token' }));
    } else { taskRequests++; response.writeHead(500); response.end('{}'); }
  }));
  const env = { YUXUN_CONFIG_DIR: dir, YUXUN_URL: url, YUXUN_PASSWORD: PASSWORD, TASKBASE_PASSWORD: 'old-password-1234' };
  await run(['src/cli.ts', 'login'], env);
  assert.deepEqual(login, { username: 'owner', password: PASSWORD });
  await assert.rejects(run(['src/cli.ts', 'login'], { ...env, YUXUN_PASSWORD: '' }), /非交互环境/);
  await assert.rejects(run(['src/cli.ts', 'task', 'run', 'limits/run', '--input-json', JSON.stringify({ text: '中'.repeat(23000) })], env), /64 KiB/);
  assert.equal(taskRequests, 0);
});
