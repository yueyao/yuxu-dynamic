#!/usr/bin/env node
/** 一次性初始化：创建所有者账号。 */
import { resolve } from 'node:path';
import { config } from './config.ts';
import { Store } from './store.ts';

const password = process.env.TASKBASE_OWNER_PASSWORD;
if (!password) {
  console.error('请设置 TASKBASE_OWNER_PASSWORD（至少 12 个字符）后运行 bootstrap。');
  process.exit(1);
}
const store = new Store(config.dbPath, { leaseMs: config.leaseMs });
try {
  store.bootstrap(config.ownerUsername, password);
  console.log(`初始化完成：用户 ${config.ownerUsername}`);
  console.log(`数据库：${resolve(config.dbPath)}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  store.closeDb();
}
