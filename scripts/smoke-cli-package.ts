import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageInfo = JSON.parse(await readFile('apps/cli/package.json', 'utf8')) as {
  name: string;
  version: string;
};
const tarball = resolve('.release', `${packageInfo.name}-${packageInfo.version}.tgz`);
const directory = await mkdtemp(join(tmpdir(), 'yuxu-cli-package-'));
const prefix = join(directory, 'global');
const config = join(directory, 'config');
const binary = join(prefix, 'bin', process.platform === 'win32' ? 'yuxu.cmd' : 'yuxu');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  await execFileAsync(npm, ['install', '--global', '--prefix', prefix, tarball], {
    encoding: 'utf8',
  });
  const help = await execFileAsync(binary, ['--help'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.match(help.stdout, /yuxu config set-server/);

  const environment = { ...process.env, YUXU_CLI_DIR: config };
  const setServer = await execFileAsync(binary,
    ['config', 'set-server', 'http://127.0.0.1:3333'], {
      encoding: 'utf8', shell: process.platform === 'win32', env: environment,
    });
  assert.match(setServer.stdout, /服务器地址已设置/);

  const show = await execFileAsync(binary, ['config', 'show'], {
    encoding: 'utf8', shell: process.platform === 'win32', env: environment,
  });
  assert.equal(JSON.parse(show.stdout).effective_server, 'http://127.0.0.1:3333');
  console.log(`CLI 安装包验证通过：${packageInfo.name}@${packageInfo.version}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
