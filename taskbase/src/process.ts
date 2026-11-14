/** 有时限、可取消的子进程。等待退出后再清理文件，避免留下 ASR/ffmpeg 子进程。 */
import { spawn } from 'node:child_process';

export async function runProcess(command: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv;
} = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30 * 60 * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], env: options.env });
    let stdout = '';
    let stderr = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* 进程已经退出。 */ }
    };
    const onAbort = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(killTimer); signal.removeEventListener('abort', onAbort); };
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => {
      if (signal.aborted && grouped) kill('SIGKILL');
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve(stdout);
      else reject(new Error(`${command} 失败（${code}）：${stderr.slice(-1000)}`));
    });
  });
}
