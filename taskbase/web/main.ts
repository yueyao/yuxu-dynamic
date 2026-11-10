#!/usr/bin/env node
/** 播客 Web 端入口。 */
import { resolve } from 'node:path';
import { config } from '../src/config.ts';
import { diagnosticMessage, redactText } from '../src/redact.ts';
import { createWebServer } from './server.ts';

const server = createWebServer({
  platformUrl: config.platformUrl,
  dbPath: config.dbPath,
  sessionTtlMs: config.webSessionTtlMs,
});

const port = config.webPort;
server.on('error', (error) => {
  console.error(diagnosticMessage(`Web 端无法监听 ${config.webHost}:${port}: ${diagnosticMessage(error)}`));
  process.exitCode = 1;
});
server.listen(port, config.webHost, () => {
  console.log(`Taskbase Web: http://${config.webHost}:${port}`);
  console.log(`平台 API: ${redactText(config.platformUrl)}`);
  console.log(`数据目录: ${resolve(config.dataDir)}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
