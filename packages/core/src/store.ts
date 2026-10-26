/**
 * 本地 SQLite 持久化层：集中管理身份、应用声明、任务状态、尝试、事件和产物元数据。
 * 所有状态迁移与对应事件在同一事务中提交；文件内容由 HTTP 层保存。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, exampleApp, type TaskStatus } from './model.ts';
import { hashPassword, newToken, sha256, verifyPassword } from './crypto.ts';
import { validateJsonSchema, type JsonSchema } from './schema.ts';
import { parseManifest, type ApplicationManifest } from './manifest.ts';

type TaskRow = {
  id: string;
  app_id: string;
  task_key: string;
  release_digest: string;
  status: TaskStatus;
  input_json: string;
  input_hash: string;
  origin_key: string;
  idempotency_key: string | null;
  progress: number;
  created_at: number;
  scheduled_at: number | null;
  updated_at: number;
  deadline_at: number;
  attempt_count: number;
  max_attempts: number;
  current_attempt_id: string | null;
  lease_expires_at: number | null;
  output_json: string | null;
  final_artifact_id: string | null;
  error_text: string | null;
};

type StepRow = { step_key: string; value_json: string };

/** 可安全映射到 HTTP 状态与稳定错误码的业务错误。 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 本地数据库访问对象；创建时补齐表结构，使用完毕需调用 close()。 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL, password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applications (
        app_id TEXT PRIMARY KEY, release_digest TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_definitions (
        app_id TEXT NOT NULL REFERENCES applications(app_id), task_key TEXT NOT NULL,
        release_digest TEXT NOT NULL, timeout_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL, input_schema_json TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        PRIMARY KEY (app_id, task_key)
      );
      CREATE TABLE IF NOT EXISTS worker_tokens (
        token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(app_id),
        release_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL, task_key TEXT NOT NULL,
        release_digest TEXT NOT NULL, status TEXT NOT NULL,
        input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
        origin_key TEXT NOT NULL, idempotency_key TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        scheduled_at INTEGER,
        deadline_at INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, current_attempt_id TEXT,
        lease_expires_at INTEGER, output_json TEXT, final_artifact_id TEXT,
        error_text TEXT
      );
      -- 部分唯一索引只约束带幂等键的任务，普通提交可重复创建。
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency
        ON tasks(origin_key, app_id, task_key, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_queue
        ON tasks(app_id, release_digest, status, created_at);
      CREATE INDEX IF NOT EXISTS tasks_lease
        ON tasks(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS tasks_history ON tasks(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_steps (
        task_id TEXT NOT NULL REFERENCES tasks(id), step_key TEXT NOT NULL,
        value_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, step_key)
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_cursor ON task_events(task_id, id);
      CREATE INDEX IF NOT EXISTS task_logs_cursor ON task_events(task_id, type, id);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT NOT NULL, name TEXT NOT NULL,
        content_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn('task_definitions', 'input_schema_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('task_definitions', 'output_schema_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('tasks', 'scheduled_at', 'INTEGER');
    this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_ready
      ON tasks(app_id, release_digest, status, scheduled_at, created_at)`);
    // 本地 MVP 只有一个固定任务。旧数据库可能仍用硬编码校验或首版 schema，
    // 启动时将该固定声明更新为当前等价规则。
    this.db.prepare(`UPDATE task_definitions SET input_schema_json = ?, output_schema_json = ?
      WHERE app_id = ? AND task_key = ? AND release_digest = ?`)
      .run(JSON.stringify(exampleApp.inputSchema), JSON.stringify(exampleApp.outputSchema),
        exampleApp.appId, exampleApp.taskKey, exampleApp.releaseDigest);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    // 为旧版本地数据库补兼容字段；生产环境应使用有版本的 SQL 迁移。
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  health(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  private transaction<T>(work: () => T): T {
    // 领取任务前先获取写锁，使容量检查与领取在同一事务内完成。
    // PostgreSQL 实现可改用行锁，但必须保持同样的原子性。
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private event(taskId: string, attemptId: string | null, type: string, payload: unknown, now = Date.now()): void {
    this.db.prepare(`INSERT INTO task_events(task_id, attempt_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(taskId, attemptId, type, JSON.stringify(payload), now);
  }

  /** 一次性创建所有者、示例应用和 Worker 凭据；已有用户时拒绝再次初始化。 */
  bootstrap(username: string, password: string, workerToken = newToken()): string {
    if (username.trim().length === 0 || password.length < 12) {
      throw new AppError(400, 'INVALID_BOOTSTRAP', '用户名不能为空，密码至少需要 12 个字符');
    }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM users LIMIT 1').get();
      if (existing) throw new AppError(409, 'ALREADY_INITIALIZED', '平台已经初始化');
      const userId = randomUUID();
      const passwordData = hashPassword(password);
      this.db.prepare(`INSERT INTO users(id, username, password_salt, password_hash)
        VALUES (?, ?, ?, ?)`).run(userId, username, passwordData.salt, passwordData.hash);
      this.db.prepare(`INSERT INTO applications(app_id, release_digest, max_concurrency)
        VALUES (?, ?, ?)`).run(exampleApp.appId, exampleApp.releaseDigest, exampleApp.maxConcurrency);
      this.db.prepare(`INSERT INTO task_definitions(app_id, task_key, release_digest, timeout_ms,
        max_attempts, input_schema_json, output_schema_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        exampleApp.appId, exampleApp.taskKey, exampleApp.releaseDigest,
        exampleApp.timeoutMs, exampleApp.maxAttempts,
        JSON.stringify(exampleApp.inputSchema), JSON.stringify(exampleApp.outputSchema),
      );
      this.db.prepare(`INSERT INTO worker_tokens(token_hash, app_id, release_digest)
        VALUES (?, ?, ?)`).run(sha256(workerToken), exampleApp.appId, exampleApp.releaseDigest);
      return workerToken;
    });
  }

  /** 在单个事务内登记新应用、任务定义及其 Worker 凭据；不覆盖已有应用。 */
  registerApplication(manifest: ApplicationManifest, workerToken = newToken()): string {
    const valid = parseManifest(manifest);
    return this.transaction(() => {
      if (this.db.prepare('SELECT app_id FROM applications WHERE app_id = ?').get(valid.app_id)) {
        throw new AppError(409, 'APP_ALREADY_REGISTERED', '应用已注册；本阶段不支持替换发布版本');
      }
      this.db.prepare(`INSERT INTO applications(app_id, release_digest, max_concurrency)
        VALUES (?, ?, ?)`).run(valid.app_id, valid.release_digest, valid.max_concurrency);
      const insert = this.db.prepare(`INSERT INTO task_definitions(app_id, task_key, release_digest,
        timeout_ms, max_attempts, input_schema_json, output_schema_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const task of valid.tasks) {
        insert.run(valid.app_id, task.task_key, valid.release_digest, task.timeout_ms,
          task.max_attempts, JSON.stringify(task.input_schema), JSON.stringify(task.output_schema));
      }
      this.db.prepare(`INSERT INTO worker_tokens(token_hash, app_id, release_digest)
        VALUES (?, ?, ?)`).run(sha256(workerToken), valid.app_id, valid.release_digest);
      return workerToken;
    });
  }

  /** 校验密码并签发有期限的 CLI Token；数据库只保存 Token 摘要。 */
  login(username: string, password: string): string {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | { id: string; password_salt: string; password_hash: string } | undefined;
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
    const token = newToken();
    this.db.prepare('INSERT INTO api_tokens(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), user.id, Date.now() + 90 * 24 * 60 * 60 * 1000);
    return token;
  }

  userForToken(token: string): { id: string } | null {
    const row = this.db.prepare(`SELECT u.id FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.expires_at > ?`).get(sha256(token), Date.now()) as { id: string } | undefined;
    return row ?? null;
  }

  workerForToken(token: string): { appId: string; releaseDigest: string } | null {
    const row = this.db.prepare('SELECT app_id, release_digest FROM worker_tokens WHERE token_hash = ?')
      .get(sha256(token)) as { app_id: string; release_digest: string } | undefined;
    return row ? { appId: row.app_id, releaseDigest: row.release_digest } : null;
  }

  listApps(): Array<{ app_id: string; release_digest: string }> {
    return this.db.prepare('SELECT app_id, release_digest FROM applications ORDER BY app_id').all() as
      Array<{ app_id: string; release_digest: string }>;
  }

  listDefinitions(appId: string): Array<{ task_key: string; release_digest: string; input_schema: JsonSchema; output_schema: JsonSchema }> {
    const rows = this.db.prepare(`SELECT task_key, release_digest, input_schema_json, output_schema_json
      FROM task_definitions WHERE app_id = ? ORDER BY task_key`).all(appId) as Array<{
        task_key: string; release_digest: string; input_schema_json: string; output_schema_json: string;
      }>;
    return rows.map((row) => ({
      task_key: row.task_key,
      release_digest: row.release_digest,
      input_schema: JSON.parse(row.input_schema_json) as JsonSchema,
      output_schema: JSON.parse(row.output_schema_json) as JsonSchema,
    }));
  }

  /** 校验输入并创建排队任务；同一主体和幂等键可安全复用已有任务。 */
  createTask(originKey: string, appId: string, taskKey: string, input: unknown,
    idempotencyKey: string | null, scheduledAt: number | null = null): { task: ReturnType<Store['getTask']>; reused: boolean } {
    if (input === undefined) throw new AppError(400, 'INVALID_INPUT', '任务必须提供 input');
    const definition = this.db.prepare(`SELECT * FROM task_definitions WHERE app_id = ? AND task_key = ?`)
      .get(appId, taskKey) as {
        release_digest: string; timeout_ms: number; max_attempts: number;
        input_schema_json: string; output_schema_json: string;
      } | undefined;
    if (!definition) throw new AppError(404, 'TASK_DEFINITION_NOT_FOUND', '任务定义不存在');
    const issues = validateJsonSchema(JSON.parse(definition.input_schema_json) as JsonSchema, input);
    if (issues.length > 0) {
      throw new AppError(400, 'INVALID_INPUT', issues.slice(0, 8)
        .map((issue) => `${issue.path} ${issue.message}`).join('；'));
    }
    const inputJson = JSON.stringify(input);
    const inputHash = sha256(canonicalJson(input));
    return this.transaction(() => {
      if (idempotencyKey !== null) {
        const existing = this.db.prepare(`SELECT * FROM tasks WHERE origin_key = ? AND app_id = ?
          AND task_key = ? AND idempotency_key = ?`)
          .get(originKey, appId, taskKey, idempotencyKey) as TaskRow | undefined;
        if (existing) {
          if (existing.input_hash !== inputHash || existing.scheduled_at !== scheduledAt) {
            throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同输入或计划时间');
          }
          return { task: this.toTask(existing), reused: true };
        }
      }
      // 先查幂等键，确保计划时间过去后重试原请求仍会返回原任务。
      const now = Date.now();
      if (scheduledAt !== null && (!Number.isSafeInteger(scheduledAt) || scheduledAt < now ||
        scheduledAt > now + 365 * 24 * 60 * 60 * 1000)) {
        throw new AppError(400, 'INVALID_RUN_AT', 'run_at 必须在未来一年内');
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO tasks(
        id, app_id, task_key, release_digest, status, input_json, input_hash,
        origin_key, idempotency_key, created_at, updated_at, scheduled_at, deadline_at, max_attempts
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, appId, taskKey, definition.release_digest, inputJson, inputHash,
        originKey, idempotencyKey, now, now, scheduledAt,
        (scheduledAt ?? now) + definition.timeout_ms, definition.max_attempts,
      );
      this.event(id, null, 'status', { status: 'queued', scheduled_at: scheduledAt === null
        ? null : new Date(scheduledAt).toISOString() }, now);
      return { task: this.getTask(id), reused: false };
    });
  }

  private taskRow(id: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!row) throw new AppError(404, 'TASK_NOT_FOUND', '任务不存在');
    return row;
  }

  private toTask(row: TaskRow) {
    return {
      task_id: row.id,
      app_id: row.app_id,
      task_key: row.task_key,
      release_digest: row.release_digest,
      status: row.status,
      progress: row.progress,
      created_at: new Date(row.created_at).toISOString(),
      scheduled_at: row.scheduled_at === null ? null : new Date(row.scheduled_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      deadline_at: new Date(row.deadline_at).toISOString(),
      attempt_count: row.attempt_count,
      output: row.output_json ? JSON.parse(row.output_json) as unknown : null,
      artifact_id: row.final_artifact_id,
      error: row.error_text,
    };
  }

  getTask(id: string) {
    return this.toTask(this.taskRow(id));
  }

  /** 用创建时间和 UUID 组成稳定游标；新任务不会挤动已翻过的历史页。 */
  listTasks(filters: { appId?: string; taskKey?: string; status?: TaskStatus; limit?: number; cursor?: string }) {
    const limit = filters.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError(400, 'INVALID_LIMIT', 'limit 必须为 1 至 100 的整数');
    }
    let position: [number, string] | null = null;
    if (filters.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(decoded) || decoded.length !== 2 ||
          !Number.isSafeInteger(decoded[0]) || typeof decoded[1] !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(decoded[1])) throw new Error('invalid cursor');
        position = decoded as [number, string];
      } catch { throw new AppError(400, 'INVALID_CURSOR', '任务历史游标无效'); }
    }
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filters.appId) { where.push('app_id = ?'); args.push(filters.appId); }
    if (filters.taskKey) { where.push('task_key = ?'); args.push(filters.taskKey); }
    if (filters.status) { where.push('status = ?'); args.push(filters.status); }
    if (position) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(position[0], position[0], position[1]);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit + 1) as TaskRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      tasks: page.map((row) => this.toTask(row)),
      next_cursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') : null,
    };
  }

  /** 结果与状态一起返回，未结束的任务可由调用方继续轮询。 */
  getResult(id: string) {
    const task = this.getTask(id);
    return { task_id: task.task_id, status: task.status, output: task.output,
      artifact_id: task.artifact_id, error: task.error };
  }

  /** 按单调事件 ID 分页读取任务事件，每次最多返回 100 条。 */
  getEvents(id: string, after = 0) {
    this.taskRow(id);
    const rows = this.db.prepare(`SELECT id, attempt_id, type, payload_json, created_at
      FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 100`).all(id, after) as
      Array<{ id: number; attempt_id: string | null; type: string; payload_json: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id, attempt_id: row.attempt_id, type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  /** 日志使用事件的全局单调 ID，恢复执行后仍可从上一游标续读。 */
  getLogs(id: string, after = 0) {
    this.taskRow(id);
    const rows = this.db.prepare(`SELECT id, attempt_id, payload_json, created_at
      FROM task_events WHERE task_id = ? AND type = 'log' AND id > ? ORDER BY id LIMIT 100`)
      .all(id, after) as Array<{ id: number; attempt_id: string | null; payload_json: string; created_at: number }>;
    return rows.map((row) => ({ id: row.id, attempt_id: row.attempt_id,
      ...(JSON.parse(row.payload_json) as { level: string; message: string }),
      created_at: new Date(row.created_at).toISOString() }));
  }

  /** 只有当前有效尝试能写入日志，避免旧 Worker 在恢复后污染新执行记录。 */
  log(taskId: string, attemptId: string, appId: string, level: string, message: string): void {
    this.transaction(() => {
      this.assertCurrentAttempt(taskId, attemptId, appId);
      this.event(taskId, attemptId, 'log', { level, message });
    });
  }

  /** 为匹配应用版本的 Worker 原子领取一个任务，并返回已确认的检查点。 */
  lease(appId: string, releaseDigest: string, leaseMs: number) {
    return this.transaction(() => {
      const app = this.db.prepare('SELECT max_concurrency FROM applications WHERE app_id = ?')
        .get(appId) as { max_concurrency: number } | undefined;
      if (!app) throw new AppError(403, 'WORKER_APP_UNKNOWN', 'Worker 应用不存在');
      const active = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks
        WHERE app_id = ? AND status = 'running'`).get(appId) as { count: number };
      if (active.count >= app.max_concurrency) return null;
      // 容量检查与领取同事务提交，已领取任务始终有对应的尝试记录。
      const row = this.db.prepare(`SELECT * FROM tasks WHERE app_id = ? AND release_digest = ?
        AND status IN ('queued', 'recovering') AND deadline_at > ?
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
        ORDER BY COALESCE(scheduled_at, created_at), created_at, id LIMIT 1`)
        .get(appId, releaseDigest, Date.now(), Date.now()) as TaskRow | undefined;
      if (!row) return null;
      const now = Date.now();
      const attemptId = randomUUID();
      const attemptNumber = row.attempt_count + 1;
      this.db.prepare(`UPDATE tasks SET status = 'running', current_attempt_id = ?,
        attempt_count = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`).run(
        attemptId, attemptNumber, Math.min(now + leaseMs, row.deadline_at), now, row.id,
      );
      this.db.prepare(`INSERT INTO task_attempts(id, task_id, attempt_number, status, started_at)
        VALUES (?, ?, ?, 'running', ?)`).run(attemptId, row.id, attemptNumber, now);
      this.event(row.id, attemptId, 'status', { status: 'running', attempt_number: attemptNumber }, now);
      const steps = this.db.prepare('SELECT step_key, value_json FROM task_steps WHERE task_id = ?')
        .all(row.id) as StepRow[];
      return {
        task_id: row.id,
        attempt_id: attemptId,
        attempt_number: attemptNumber,
        app_id: row.app_id,
        task_key: row.task_key,
        release_digest: row.release_digest,
        input: JSON.parse(row.input_json) as unknown,
        deadline_at: new Date(row.deadline_at).toISOString(),
        steps: Object.fromEntries(steps.map((step) => [step.step_key, JSON.parse(step.value_json) as unknown])),
      };
    });
  }

  private currentAttempt(taskId: string, attemptId: string, now = Date.now()): TaskRow {
    const row = this.taskRow(taskId);
    // attempt_id 是隔离旧执行者的凭据；租约失效后，旧 Worker 的迟到写入必须被拒绝。
    if (row.status !== 'running' || row.current_attempt_id !== attemptId ||
      row.lease_expires_at === null || row.lease_expires_at <= now || row.deadline_at <= now) {
      throw new AppError(409, 'STALE_ATTEMPT', '当前尝试已失去任务租约');
    }
    return row;
  }

  assertCurrentAttempt(taskId: string, attemptId: string, appId: string): void {
    const row = this.currentAttempt(taskId, attemptId);
    if (row.app_id !== appId) throw new AppError(403, 'WRONG_APP', '任务不属于该应用');
  }

  /** 当前尝试续租；租约不会超过任务总截止时间。 */
  heartbeat(taskId: string, attemptId: string, appId: string, leaseMs: number): void {
    this.transaction(() => {
      this.assertCurrentAttempt(taskId, attemptId, appId);
      const row = this.taskRow(taskId);
      this.db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(Math.min(Date.now() + leaseMs, row.deadline_at), Date.now(), taskId);
    });
  }

  progress(taskId: string, attemptId: string, appId: string, progress: number, message: string): void {
    this.transaction(() => {
      this.assertCurrentAttempt(taskId, attemptId, appId);
      const now = Date.now();
      this.db.prepare('UPDATE tasks SET progress = MAX(progress, ?), updated_at = ? WHERE id = ?')
        .run(progress, now, taskId);
      this.event(taskId, attemptId, 'progress', { progress, message }, now);
    });
  }

  /** 保存不可变的步骤结果，供中断后新的执行尝试复用。 */
  saveStep(taskId: string, attemptId: string, appId: string, stepKey: string, value: unknown): void {
    this.transaction(() => {
      this.assertCurrentAttempt(taskId, attemptId, appId);
      const existing = this.db.prepare('SELECT value_json FROM task_steps WHERE task_id = ? AND step_key = ?')
        .get(taskId, stepKey) as { value_json: string } | undefined;
      const valueJson = JSON.stringify(value);
      // 已确认的检查点不可修改，恢复执行时才能安全复用。
      if (existing) {
        if (canonicalJson(JSON.parse(existing.value_json)) !== canonicalJson(value)) {
          throw new AppError(409, 'STEP_CONFLICT', '已确认的步骤结果不可修改');
        }
        return;
      }
      const now = Date.now();
      this.db.prepare('INSERT INTO task_steps(task_id, step_key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(taskId, stepKey, valueJson, now);
      this.event(taskId, attemptId, 'step', { step_key: stepKey }, now);
    });
  }

  createArtifact(taskId: string, attemptId: string, appId: string, id: string, name: string, contentType: string, byteSize: number, checksum: string): void {
    this.transaction(() => {
      this.assertCurrentAttempt(taskId, attemptId, appId);
      this.db.prepare(`INSERT INTO artifacts(id, task_id, attempt_id, name, content_type,
        byte_size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, taskId, attemptId, name, contentType, byteSize, checksum, Date.now(),
      );
      this.event(taskId, attemptId, 'artifact', { artifact_id: id, name });
    });
  }

  /** 校验输出；有产物时校验其尝试归属，再提交成功终态。 */
  complete(taskId: string, attemptId: string, appId: string, output: unknown): ReturnType<Store['getTask']> {
    return this.transaction(() => {
      const row = this.taskRow(taskId);
      if (row.app_id !== appId) throw new AppError(403, 'WRONG_APP', '任务不属于该应用');
      if (row.status === 'succeeded' && row.current_attempt_id === attemptId && row.output_json &&
        canonicalJson(JSON.parse(row.output_json)) === canonicalJson(output)) {
        return this.toTask(row);
      }
      this.assertCurrentAttempt(taskId, attemptId, appId);
      const definition = this.db.prepare(`SELECT output_schema_json FROM task_definitions
        WHERE app_id = ? AND task_key = ?`).get(appId, row.task_key) as { output_schema_json: string };
      const outputIssues = validateJsonSchema(JSON.parse(definition.output_schema_json) as JsonSchema, output);
      if (outputIssues.length > 0) {
        throw new AppError(400, 'INVALID_OUTPUT', outputIssues.map((issue) => `${issue.path} ${issue.message}`).join('；'));
      }
      const outputJson = JSON.stringify(output);
      const artifactId = typeof output === 'object' && output !== null && !Array.isArray(output) &&
        'artifact_id' in output ? (output as { artifact_id: unknown }).artifact_id : null;
      if (artifactId !== null) {
        if (typeof artifactId !== 'string') throw new AppError(400, 'INVALID_OUTPUT', 'artifact_id 必须是字符串');
        const artifact = this.db.prepare(`SELECT id FROM artifacts WHERE id = ? AND task_id = ? AND attempt_id = ?`)
          .get(artifactId, taskId, attemptId);
        if (!artifact) throw new AppError(400, 'ARTIFACT_NOT_READY', '产物不存在或不属于当前尝试');
      }
      const now = Date.now();
      this.db.prepare(`UPDATE tasks SET status = 'succeeded', progress = 100,
        output_json = ?, final_artifact_id = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(outputJson, artifactId, now, taskId);
      this.db.prepare(`UPDATE task_attempts SET status = 'succeeded', finished_at = ? WHERE id = ?`)
        .run(now, attemptId);
      this.event(taskId, attemptId, 'status', { status: 'succeeded' }, now);
      return this.getTask(taskId);
    });
  }

  fail(taskId: string, attemptId: string, appId: string, message: string): ReturnType<Store['getTask']> {
    return this.transaction(() => {
      const row = this.taskRow(taskId);
      if (row.app_id !== appId) throw new AppError(403, 'WRONG_APP', '任务不属于该应用');
      if (row.status === 'failed' && row.current_attempt_id === attemptId && row.error_text === message) {
        return this.toTask(row);
      }
      this.assertCurrentAttempt(taskId, attemptId, appId);
      const now = Date.now();
      this.db.prepare(`UPDATE tasks SET status = 'failed', error_text = ?, lease_expires_at = NULL,
        updated_at = ? WHERE id = ?`).run(message, now, taskId);
      this.db.prepare(`UPDATE task_attempts SET status = 'failed', finished_at = ? WHERE id = ?`)
        .run(now, attemptId);
      this.event(taskId, attemptId, 'status', { status: 'failed', error: message }, now);
      return this.getTask(taskId);
    });
  }

  /** 回收过期租约和超时排队任务；未耗尽尝试次数的任务进入 recovering。 */
  recoverExpired(now = Date.now()): number {
    return this.transaction(() => {
      const pending = this.db.prepare(`SELECT id FROM tasks WHERE status IN ('queued', 'recovering')
        AND deadline_at <= ?`).all(now) as Array<{ id: string }>;
      for (const task of pending) {
        this.db.prepare(`UPDATE tasks SET status = 'failed', error_text = '任务超时',
          updated_at = ? WHERE id = ?`).run(now, task.id);
        this.event(task.id, null, 'status', { status: 'failed', reason: 'timeout' }, now);
      }
      const rows = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'
        AND (lease_expires_at <= ? OR deadline_at <= ?)`).all(now, now) as TaskRow[];
      for (const row of rows) {
        // 恢复会创建新尝试，执行语义为至少一次；外部副作用需自行保证幂等。
        const timedOut = row.deadline_at <= now;
        const exhausted = row.attempt_count >= row.max_attempts;
        const status = timedOut || exhausted ? 'failed' : 'recovering';
        this.db.prepare(`UPDATE task_attempts SET status = ?, finished_at = ? WHERE id = ?`)
          .run(timedOut ? 'timeout' : 'interrupted', now, row.current_attempt_id);
        this.db.prepare(`UPDATE tasks SET status = ?, current_attempt_id = NULL,
          lease_expires_at = NULL, updated_at = ?, error_text = ? WHERE id = ?`).run(
          status, now, status === 'failed' ? (timedOut ? '任务超时' : '中断次数已达上限') : null, row.id,
        );
        this.event(row.id, row.current_attempt_id, 'status', { status, reason: timedOut ? 'timeout' : 'lease_expired' }, now);
      }
      return rows.length + pending.length;
    });
  }

  /** 仅返回成功任务最终产物的元数据，供 HTTP 层读取并校验文件。 */
  getArtifactForDownload(id: string): { name: string; content_type: string; byte_size: number; sha256: string } {
    const row = this.db.prepare(`SELECT a.name, a.content_type, a.byte_size, a.sha256
      FROM artifacts a JOIN tasks t ON t.id = a.task_id
      WHERE a.id = ? AND t.status = 'succeeded' AND t.final_artifact_id = a.id`)
      .get(id) as { name: string; content_type: string; byte_size: number; sha256: string } | undefined;
    if (!row) throw new AppError(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    return row;
  }
}
