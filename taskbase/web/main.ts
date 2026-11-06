#!/usr/bin/env node
/** 播客 Web 端入口。 */
import { resolve } from 'node:path';
import { config } from '../src/config.ts';
import { createWebServer } from './server.ts';

const server = createWebServer({
  platformUrl: config.platformUrl,
  dbPath: config.dbPath,
  sessionTtlMs: config.webSessionTtlMs,
});

const port = Number(process.env.TASKBASE_WEB_PORT ?? config.webPort);
server.on('error', (error) => {
  console.error(`Web 端无法监听 ${config.webHost}:${port}: ${(error as Error).message}`);
  process.exitCode = 1;
});
server.listen(port, config.webHost, () => {
  console.log(`Taskbase Web: http://${config.webHost}:${port}`);
  console.log(`平台 API: ${config.platformUrl}`);
  console.log(`数据目录: ${resolve(config.dataDir)}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
