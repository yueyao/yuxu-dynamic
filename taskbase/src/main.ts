#!/usr/bin/env node
/** 平台 API 进程入口。 */
import { resolve } from 'node:path';
import { config } from './config.ts';
import { Store } from './store.ts';
import { createPlatformServer } from './server.ts';

const store = new Store(config.dbPath, { leaseMs: config.leaseMs });
const server = createPlatformServer(store, {
  artifactDir: config.artifactDir,
  leaseMs: config.leaseMs,
  sweepMs: config.sweepMs,
  schedulerMs: config.schedulerMs,
  scheduleGraceMs: config.scheduleGraceMs,
  maxArtifactBytes: config.maxArtifactBytes,
});

const port = Number(process.env.TASKBASE_PORT ?? config.port);
server.on('error', (error) => {
  console.error(`平台 API 无法监听 ${config.host}:${port}: ${(error as Error).message}`);
  store.closeDb();
  process.exitCode = 1;
});
server.listen(port, config.host, () => {
  console.log(`Taskbase API: http://${config.host}:${port}`);
  console.log(`数据目录: ${resolve(config.dataDir)}`);
});

function shutdown(): void {
  server.close(() => {
    store.closeDb();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
