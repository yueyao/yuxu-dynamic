#!/usr/bin/env node
/**
 * 安装真正脱离仓库的全局 taskbase 命令：
 *   runtime: ~/.local/share/taskbase/runtime
 *   bin:     ~/.local/bin/taskbase
 *
 * 运行时目录只复制执行所需文件；npm 全局安装不适合本项目的 .ts 源码，
 * 因为 Node 24 会拒绝执行 node_modules 内的 TypeScript 文件。
 */
import { cp, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = resolve(process.env.TASKBASE_GLOBAL_HOME ?? join(homedir(), '.local', 'share', 'taskbase', 'runtime'));
const BIN = resolve(process.env.TASKBASE_BIN_DIR ?? join(homedir(), '.local', 'bin'));

async function copyRuntime(): Promise<void> {
  await rm(RUNTIME, { recursive: true, force: true });
  await mkdir(RUNTIME, { recursive: true, mode: 0o755 });
  for (const entry of ['src', 'scripts', 'web', 'demo', 'deploy']) {
    const source = join(ROOT, entry);
    if (!existsSync(source)) continue;
    await cp(source, join(RUNTIME, entry), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json', 'README.md']) {
    const source = join(ROOT, file);
    if (existsSync(source)) await cp(source, join(RUNTIME, file));
  }
}

async function writeBin(name: string, relativeScript: string): Promise<string> {
  const target = join(BIN, name);
  const script = join(RUNTIME, relativeScript);
  await rm(target, { force: true });
  await writeFile(target, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

async function main(): Promise<void> {
  await copyRuntime();
  await mkdir(BIN, { recursive: true, mode: 0o755 });
  const cli = await writeBin('taskbase', 'src/cli.ts');
  const agent = await writeBin('taskbase-mac-agent', 'scripts/mac-agent.ts');
  console.log(`运行时：${RUNTIME}`);
  console.log(`CLI：${cli}`);
  console.log(`Mac Agent：${agent}`);
  console.log('下一步：taskbase mac doctor && taskbase mac install');
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
