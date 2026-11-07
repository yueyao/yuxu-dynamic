import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(...args: string[]): string {
  const result = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('默认帮助只展示日常命令', () => {
  const output = run('help');
  assert.match(output, /yuxun status/);
  assert.match(output, /yuxun transcribe/);
  assert.match(output, /yuxun worker/);
  assert.doesNotMatch(output, /yuxun task run/);
  assert.match(output, /help --all/);
});

test('help --all 展示任务、调度与平台命令', () => {
  const output = run('help', '--all');
  assert.match(output, /yuxun task run/);
  assert.match(output, /yuxun schedule add/);
  assert.match(output, /yuxun apps/);
  assert.match(output, /yuxun artifact download/);
});

test('分组命令不带参数时只打印帮助', () => {
  assert.match(run('worker'), /Worker 命令/);
  assert.match(run('task'), /任务命令/);
  assert.match(run('schedule'), /调度命令/);
  assert.match(run('app'), /应用命令/);
  assert.match(run('artifact'), /产物命令/);
});
