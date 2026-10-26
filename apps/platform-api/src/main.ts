/** 平台 API 进程入口：打开本地存储、创建 HTTP 服务并在退出时关闭数据库。 */
import { resolve } from 'node:path';
import { Store } from '../../../packages/core/src/store.ts';
import { createApiServer } from './server.ts';

const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
const store = new Store(resolve(dataDir, 'platform.sqlite'));
const server = createApiServer(store, {
  artifactDir: resolve(dataDir, 'artifacts'),
  leaseMs: Number(process.env.PLATFORM_LEASE_MS ?? 60_000),
  sweepMs: Number(process.env.PLATFORM_SWEEP_MS ?? 5_000),
});
const port = Number(process.env.PORT ?? 3333);
const host = '127.0.0.1';
server.on('error', (error) => {
  console.error(`平台 API 无法监听 ${host}:${port}: ${(error as Error).message}`);
  store.close();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`平台 API: http://${host}:${port}`));

function shutdown(): void {
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
