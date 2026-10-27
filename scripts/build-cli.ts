import { copyFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const output = resolve('apps/cli/package-dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const compiler = resolve('node_modules/typescript/bin/tsc');
const child = spawn(process.execPath, [compiler, '-p', 'tsconfig.cli.build.json'], {
  stdio: 'inherit',
});

const exitCode = await new Promise<number>((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`TypeScript 编译被信号 ${signal} 终止`));
    else resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  await copyFile('LICENSE', `${output}/LICENSE`);
}
