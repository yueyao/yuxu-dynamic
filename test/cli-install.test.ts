import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('npm bin 符号链接可以启动 CLI', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuxu-cli-bin-'));
  const bin = join(directory, 'yuxu');
  try {
    await symlink(resolve('apps/cli/src/main.ts'), bin);
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, '--help'], {
      encoding: 'utf8',
    });
    assert.match(stdout, /yuxu config set-server/);
    assert.equal(stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
