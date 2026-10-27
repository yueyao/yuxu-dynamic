import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

await mkdir('.release', { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runNpm(args: string[]): Promise<number> {
  const child = spawn(npm, args, { stdio: 'inherit', env: process.env });
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`npm ${args[0]} 被信号 ${signal} 终止`));
      else resolve(code ?? 1);
    });
  });
}

const buildCode = await runNpm(['run', 'build:cli']);
if (buildCode !== 0) process.exitCode = buildCode;
else {
  // 打包已使用刚构建的文件；不把构建生命周期脚本带进发布包。
  process.exitCode = await runNpm([
    'pack', './apps/cli', '--ignore-scripts', '--pack-destination', '.release',
  ]);
}
