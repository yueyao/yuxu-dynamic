/** 本地应用注册命令：校验声明并为新应用生成独立的 Worker 凭据。 */
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newToken } from '../../../packages/core/src/crypto.ts';
import { parseManifest } from '../../../packages/core/src/manifest.ts';
import { Store } from '../../../packages/core/src/store.ts';

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('用法: npm run register-app -- <manifest.json>');
  process.exit(1);
}

const path = resolve(manifestPath);
const info = await stat(path);
if (info.size > 64 * 1024) throw new Error('应用声明不能超过 64 KiB');
const manifest = parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown);
const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const tokenFile = resolve(dataDir, `worker-token-${manifest.app_id}`);
const token = newToken();
let reserved = false;
let store: Store | undefined;
try {
  await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
  reserved = true;
  store = new Store(resolve(dataDir, 'platform.sqlite'));
  store.registerApplication(manifest, token);
  console.log(`应用 ${manifest.app_id} 已注册；Worker 凭据位于 ${tokenFile}`);
} catch (error) {
  if (reserved) await unlink(tokenFile).catch(() => {});
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  store?.close();
}
