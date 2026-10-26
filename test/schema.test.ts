/** 声明式 schema、旧 SQLite 升级和跨应用任务隔离的行为测试。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { exampleApp } from '../packages/core/src/model.ts';
import { parseManifest } from '../packages/core/src/manifest.ts';
import { validateJsonSchema } from '../packages/core/src/schema.ts';
import { AppError, Store } from '../packages/core/src/store.ts';

test('声明式输入 schema 拒绝缺字段、错误类型和额外字段', () => {
  assert.deepEqual(validateJsonSchema(exampleApp.inputSchema, { title: '报告' }), []);
  assert.deepEqual(validateJsonSchema(exampleApp.inputSchema, {}), [
    { path: '$.title', message: '此字段必填' },
  ]);
  assert.deepEqual(validateJsonSchema(exampleApp.inputSchema, { title: 7 }), [
    { path: '$.title', message: '必须是 string' },
  ]);
  assert.deepEqual(validateJsonSchema(exampleApp.inputSchema, { title: '   ' }), [
    { path: '$.title', message: '格式不符合要求' },
  ]);
  assert.deepEqual(validateJsonSchema(exampleApp.inputSchema, { title: '报告', script: 'echo hi' }), [
    { path: '$.script', message: '不允许此字段' },
  ]);
});

test('旧 SQLite 定义在打开时补齐 schema 并应用输入校验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-schema-upgrade-'));
  const path = join(dir, 'platform.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE task_definitions (
      app_id TEXT NOT NULL, task_key TEXT NOT NULL, release_digest TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      PRIMARY KEY (app_id, task_key)
    );`);
    // 模拟已有本地库的任务表：除 scheduled_at 外保留旧版全部列。
    legacy.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, task_key TEXT NOT NULL,
      release_digest TEXT NOT NULL, status TEXT NOT NULL,
      input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
      origin_key TEXT NOT NULL, idempotency_key TEXT,
      progress INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
      current_attempt_id TEXT, lease_expires_at INTEGER, output_json TEXT,
      final_artifact_id TEXT, error_text TEXT
    );`);
    legacy.prepare(`INSERT INTO task_definitions(app_id, task_key, release_digest, timeout_ms, max_attempts)
      VALUES (?, ?, ?, ?, ?)`).run(exampleApp.appId, exampleApp.taskKey,
      exampleApp.releaseDigest, exampleApp.timeoutMs, exampleApp.maxAttempts);
    legacy.close();

    const store = new Store(path);
    try {
      assert.throws(() => store.createTask('user:test', exampleApp.appId,
        exampleApp.taskKey, { title: 7 }, null),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
      const task = store.createTask('user:test', exampleApp.appId,
        exampleApp.taskKey, { title: '旧库升级' }, null).task;
      assert.equal(task.scheduled_at, null);
      assert.equal(store.getTask(task.task_id).status, 'queued');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('应用声明可注册独立任务，Worker 凭据只领取所属应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-register-'));
  const store = new Store(join(dir, 'platform.sqlite'));
  try {
    const originalToken = store.bootstrap('owner', 'a-long-test-password');
    const manifest = parseManifest({
      app_id: 'notes-app', release_digest: 'release-1', max_concurrency: 2,
      tasks: [{
        task_key: 'note/export', timeout_ms: 60_000, max_attempts: 2,
        input_schema: { type: 'object', required: ['note_id'], additionalProperties: false,
          properties: { note_id: { type: 'string', minLength: 1 } } },
        output_schema: { type: 'object', required: ['artifact_id'],
          properties: { artifact_id: { type: 'string' } } },
      }],
    });
    const token = store.registerApplication(manifest);
    assert.deepEqual(store.workerForToken(token), { appId: 'notes-app', releaseDigest: 'release-1' });
    assert.equal(store.listDefinitions('notes-app')[0].task_key, 'note/export');
    assert.throws(() => store.createTask('user:owner', 'notes-app', 'note/export', {}, null),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
    const task = store.createTask('user:owner', 'notes-app', 'note/export', { note_id: 'n1' }, null).task;
    assert.equal(store.lease(exampleApp.appId, exampleApp.releaseDigest, 60_000), null);
    assert.equal(store.lease('notes-app', 'release-1', 60_000)?.task_id, task.task_id);
    assert.ok(store.workerForToken(originalToken));
    assert.throws(() => store.registerApplication(manifest),
      (error: unknown) => error instanceof AppError && error.code === 'APP_ALREADY_REGISTERED');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
