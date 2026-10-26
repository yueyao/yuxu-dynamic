/** 一次性初始化命令：创建所有者、内置示例任务和示例 Worker 凭据。 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newToken } from '../../../packages/core/src/crypto.ts';
import { Store } from '../../../packages/core/src/store.ts';

const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!password) {
  console.error('请设置 PLATFORM_ADMIN_PASSWORD（至少 12 个字符）后运行初始化。');
  process.exit(1);
}
const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const tokenFile = resolve(dataDir, 'worker-token');
const workerToken = newToken();
// 先预留凭据文件再提交数据库初始化，避免文件写入失败后留下无法重新初始化的平台。
let reserved = false;
let store: Store | undefined;
try {
  await writeFile(tokenFile, workerToken, { flag: 'wx', mode: 0o600 });
  reserved = true;
  store = new Store(resolve(dataDir, 'platform.sqlite'));
  store.bootstrap(process.env.PLATFORM_ADMIN_USER ?? 'owner', password, workerToken);
  console.log(`初始化完成。Worker 凭据已保存到 ${tokenFile}`);
} catch (error) {
  if (reserved) await unlink(tokenFile).catch(() => {});
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  store?.close();
}
