/**
 * 平台底座持久化层：单用户、应用/任务定义、任务队列、尝试、检查点、事件和产物元数据。
 * 平台不保存任何应用领域数据；后续应用可以在同一 SQLite 文件中使用自己的前缀表。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, newToken, sha256, verifyPassword } from './crypto.ts';
import { diagnosticMessage, redactText } from './redact.ts';
import { nextFire, parseCron, validateTimezone } from './cron.ts';
import {
  canonicalJson, parseManifest, validateJsonSchema,
  type AppManifest, type JsonSchema, type TaskManifest,
} from './schema.ts';

export type TaskStatus = 'queued' | 'running' | 'recovering' | 'succeeded' | 'failed' | 'closed';
const MAX_INPUT_BYTES = 64 * 1024;

type UserRow = { id: string; username: string; password_salt: string; password_hash: string };
type AppRow = { app_id: string; display_name: string; max_concurrency: number };
type DefinitionRow = {
  app_id: string; task_key: string; display_name: string;
  input_schema_json: string; output_schema_json: string;
  queue_timeout_ms: number; execution_timeout_ms: number; max_attempts: number;
  artifact_required: number; artifact_max_bytes: number | null; schedulable: number;
  enabled: number;
};
type TaskRow = {
  id: string; app_id: string; task_key: string; source: string; origin_key: string;
  input_json: string; input_hash: string; idempotency_key: string | null;
  schedule_id: string | null; planned_fire_time: number | null;
  status: TaskStatus; progress: number; created_at: number; updated_at: number;
  queue_deadline_at: number; deadline_at: number | null; attempt_count: number;
  max_attempts: number; current_attempt_id: string | null; lease_expires_at: number | null;
  output_json: string | null; final_artifact_id: string | null; close_reason: string | null;
  closed_at: number | null; closed_by: string | null; retry_of_task_id: string | null;
  error_code: string | null; error_message: string | null;
};
type ScheduleRow = {
  id: string; app_id: string; task_key: string; input_json: string;
  cron_expression: string; timezone: string; enabled: number;
  next_fire_at: number | null; created_at: number; updated_at: number;
};
type ScheduleRunRow = {
  id: string; schedule_id: string; planned_fire_time: number; status: string;
  task_id: string | null; reason: string | null; created_at: number;
};
type ArtifactRow = {
  id: string; task_id: string; attempt_id: string; name: string; content_type: string;
  byte_size: number; sha256: string; created_at: number;
};

export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly leaseMs: number;

  constructor(path: string, options: { leaseMs?: number } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.leaseMs = options.leaseMs ?? 60_000;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apps (
        app_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_definitions (
        app_id TEXT NOT NULL REFERENCES apps(app_id),
        task_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        queue_timeout_ms INTEGER NOT NULL,
        execution_timeout_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        artifact_required INTEGER NOT NULL DEFAULT 0,
        artifact_max_bytes INTEGER,
        schedulable INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, task_key)
      );
      CREATE TABLE IF NOT EXISTS worker_tokens (
        app_id TEXT PRIMARY KEY REFERENCES apps(app_id),
        token_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(app_id),
        task_key TEXT NOT NULL,
        source TEXT NOT NULL,
        schedule_id TEXT,
        planned_fire_time INTEGER,
        origin_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        queue_deadline_at INTEGER NOT NULL,
        deadline_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        current_attempt_id TEXT,
        lease_expires_at INTEGER,
        output_json TEXT,
        final_artifact_id TEXT,
        close_reason TEXT,
        closed_at INTEGER,
        closed_by TEXT,
        retry_of_task_id TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency
        ON tasks(origin_key, app_id, task_key, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_queue
        ON tasks(app_id, status, created_at);
      CREATE INDEX IF NOT EXISTS tasks_history
        ON tasks(created_at DESC, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_fire
        ON tasks(schedule_id, planned_fire_time)
        WHERE schedule_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_schedule
        ON tasks(schedule_id, status);
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(app_id),
        task_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due
        ON schedules(enabled, next_fire_at);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        planned_fire_time INTEGER NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(schedule_id, planned_fire_time)
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS task_steps (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        step_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, step_key)
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_cursor ON task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
    `);
    this.ensureColumn('tasks', 'schedule_id', 'TEXT');
    this.ensureColumn('tasks', 'planned_fire_time', 'INTEGER');
    this.ensureColumn('apps', 'last_worker_seen_at', 'INTEGER');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  closeDb(): void {
    this.db.close();
  }

  health(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  private transaction<T>(work: () => T): T {
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

  // ---------- 身份 ----------

  bootstrap(username: string, password: string): string {
    if (username.trim().length === 0 || password.length < 12) {
      throw new PlatformError(400, 'INVALID_BOOTSTRAP', '用户名不能为空，密码至少 12 个字符');
    }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM users LIMIT 1').get();
      if (existing) throw new PlatformError(409, 'ALREADY_INITIALIZED', '平台已经初始化');
      const id = randomUUID();
      const passwordData = hashPassword(password);
      this.db.prepare(`INSERT INTO users(id, username, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(id, username, passwordData.salt, passwordData.hash, Date.now());
      return id;
    });
  }

  login(username: string, password: string): string {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new PlatformError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
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

  workerForToken(token: string): { appId: string } | null {
    const row = this.db.prepare('SELECT app_id FROM worker_tokens WHERE token_hash = ?')
      .get(sha256(token)) as { app_id: string } | undefined;
    return row ? { appId: row.app_id } : null;
  }

  markWorkerSeen(appId: string, now = Date.now()): void {
    // 空闲时也会轮询领取；每 5 秒最多落盘一次，避免每条进度/日志都写应用行。
    this.db.prepare(`UPDATE apps SET last_worker_seen_at = ? WHERE app_id = ?
      AND (last_worker_seen_at IS NULL OR last_worker_seen_at <= ?)`)
      .run(now, appId, now - 5000);
  }

  // ---------- 应用与任务定义 ----------

  upsertApp(manifest: unknown, options: { rotateToken?: boolean; workerToken?: string } = {}): {
    app: AppRow; worker_token?: string;
  } {
    const parsed = parseManifest(manifest);
    return this.transaction(() => {
      const now = Date.now();
      const existing = this.db.prepare('SELECT * FROM apps WHERE app_id = ?').get(parsed.app_id) as AppRow | undefined;
      if (existing) {
        this.db.prepare('UPDATE apps SET display_name = ?, max_concurrency = ?, updated_at = ? WHERE app_id = ?')
          .run(parsed.display_name, parsed.max_concurrency, now, parsed.app_id);
      } else {
        this.db.prepare(`INSERT INTO apps(app_id, display_name, max_concurrency, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`).run(parsed.app_id, parsed.display_name, parsed.max_concurrency, now, now);
      }
      this.db.prepare('UPDATE task_definitions SET enabled = 0, updated_at = ? WHERE app_id = ?')
        .run(now, parsed.app_id);
      const insert = this.db.prepare(`INSERT INTO task_definitions(
        app_id, task_key, display_name, input_schema_json, output_schema_json,
        queue_timeout_ms, execution_timeout_ms, max_attempts, artifact_required,
        artifact_max_bytes, schedulable, enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(app_id, task_key) DO UPDATE SET
        display_name = excluded.display_name,
        input_schema_json = excluded.input_schema_json,
        output_schema_json = excluded.output_schema_json,
        queue_timeout_ms = excluded.queue_timeout_ms,
        execution_timeout_ms = excluded.execution_timeout_ms,
        max_attempts = excluded.max_attempts,
        artifact_required = excluded.artifact_required,
        artifact_max_bytes = excluded.artifact_max_bytes,
        schedulable = excluded.schedulable,
        enabled = 1,
        updated_at = excluded.updated_at`);
      for (const task of parsed.tasks) {
        insert.run(parsed.app_id, task.task_key, task.display_name,
          JSON.stringify(task.input_schema), JSON.stringify(task.output_schema),
          task.queue_timeout_ms, task.execution_timeout_ms, task.max_attempts,
          task.artifact_policy.required ? 1 : 0, task.artifact_policy.max_bytes ?? null,
          task.schedulable ? 1 : 0, now);
      }
      let workerToken: string | undefined;
      const hasToken = this.db.prepare('SELECT 1 AS ok FROM worker_tokens WHERE app_id = ?')
        .get(parsed.app_id) as { ok: number } | undefined;
      if (!hasToken || options.rotateToken) {
        workerToken = options.workerToken ?? newToken();
        this.db.prepare(`INSERT INTO worker_tokens(app_id, token_hash) VALUES (?, ?)
          ON CONFLICT(app_id) DO UPDATE SET token_hash = excluded.token_hash`)
          .run(parsed.app_id, sha256(workerToken));
      }
      const app = this.db.prepare('SELECT app_id, display_name, max_concurrency FROM apps WHERE app_id = ?')
        .get(parsed.app_id) as AppRow;
      return workerToken ? { app, worker_token: workerToken } : { app };
    });
  }

  rotateWorkerToken(appId: string): string {
    return this.transaction(() => {
      const app = this.db.prepare('SELECT 1 AS ok FROM apps WHERE app_id = ?').get(appId);
      if (!app) throw new PlatformError(404, 'APP_NOT_FOUND', '应用不存在');
      const token = newToken();
      this.db.prepare(`INSERT INTO worker_tokens(app_id, token_hash) VALUES (?, ?)
        ON CONFLICT(app_id) DO UPDATE SET token_hash = excluded.token_hash`).run(appId, sha256(token));
      return token;
    });
  }

  listApps() {
    const now = Date.now();
    const rows = this.db.prepare('SELECT app_id, display_name, max_concurrency, last_worker_seen_at FROM apps ORDER BY app_id')
      .all() as Array<AppRow & { last_worker_seen_at: number | null }>;
    return rows.map(({ last_worker_seen_at, ...app }) => ({ ...app,
      last_worker_seen_at: last_worker_seen_at === null ? null : new Date(last_worker_seen_at).toISOString(),
      worker_online: last_worker_seen_at !== null && now - last_worker_seen_at < 90_000,
    }));
  }

  getApp(appId: string): AppRow | null {
    return (this.db.prepare('SELECT app_id, display_name, max_concurrency FROM apps WHERE app_id = ?')
      .get(appId) as AppRow | undefined) ?? null;
  }

  listDefinitions(appId: string): Array<{
    task_key: string; display_name: string; input_schema: JsonSchema; output_schema: JsonSchema;
    queue_timeout_ms: number; execution_timeout_ms: number; max_attempts: number;
    artifact_policy: { required: boolean; max_bytes?: number }; schedulable: boolean;
  }> {
    const rows = this.db.prepare(`SELECT * FROM task_definitions WHERE app_id = ? AND enabled = 1 ORDER BY task_key`)
      .all(appId) as DefinitionRow[];
    return rows.map((row) => this.toDefinition(row));
  }

  private definitionRow(appId: string, taskKey: string, options: { enabledOnly?: boolean } = {}): DefinitionRow {
    const row = this.db.prepare(`SELECT * FROM task_definitions WHERE app_id = ? AND task_key = ?`)
      .get(appId, taskKey) as DefinitionRow | undefined;
    if (!row || (options.enabledOnly && row.enabled === 0)) {
      throw new PlatformError(404, 'TASK_DEFINITION_NOT_FOUND', '任务定义不存在或已停用');
    }
    return row;
  }

  private toDefinition(row: DefinitionRow) {
    return {
      task_key: row.task_key,
      display_name: row.display_name,
      input_schema: parseJson<JsonSchema>(row.input_schema_json),
      output_schema: parseJson<JsonSchema>(row.output_schema_json),
      queue_timeout_ms: row.queue_timeout_ms,
      execution_timeout_ms: row.execution_timeout_ms,
      max_attempts: row.max_attempts,
      artifact_policy: {
        required: row.artifact_required === 1,
        ...(row.artifact_max_bytes === null ? {} : { max_bytes: row.artifact_max_bytes }),
      },
      schedulable: row.schedulable === 1,
    };
  }

  // ---------- 任务 ----------

  private validateInput(definition: DefinitionRow, input: unknown): string {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new PlatformError(400, 'INVALID_INPUT', '任务 input 必须是 JSON 对象');
    }
    const json = JSON.stringify(input);
    if (Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) {
      throw new PlatformError(413, 'INPUT_TOO_LARGE', '任务输入超过 64 KiB');
    }
    const issues = validateJsonSchema(parseJson<JsonSchema>(definition.input_schema_json), input);
    if (issues.length > 0) {
      throw new PlatformError(400, 'INVALID_INPUT', issues.slice(0, 8)
        .map((issue) => `${issue.path} ${issue.message}`).join('；'));
    }
    return json;
  }

  createTask(originKey: string, appId: string, taskKey: string, input: unknown,
    idempotencyKey: string | null = null): { task: ReturnType<Store['getTask']>; reused: boolean } {
    if (input === undefined) throw new PlatformError(400, 'INVALID_INPUT', '任务必须提供 input');
    const definition = this.definitionRow(appId, taskKey, { enabledOnly: true });
    const inputJson = this.validateInput(definition, input);
    const inputHash = sha256(canonicalJson(input));
    return this.transaction(() => {
      if (idempotencyKey !== null) {
        const existing = this.db.prepare(`SELECT * FROM tasks WHERE origin_key = ? AND app_id = ?
          AND task_key = ? AND idempotency_key = ?`)
          .get(originKey, appId, taskKey, idempotencyKey) as TaskRow | undefined;
        if (existing) {
          if (existing.input_hash !== inputHash) {
            throw new PlatformError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同输入');
          }
          return { task: this.toTask(existing), reused: true };
        }
      }
      const now = Date.now();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO tasks(
        id, app_id, task_key, source, origin_key, input_json, input_hash, idempotency_key,
        status, progress, created_at, updated_at, queue_deadline_at, max_attempts
      ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`).run(
        id, appId, taskKey, originKey, inputJson, inputHash, idempotencyKey,
        now, now, now + definition.queue_timeout_ms, definition.max_attempts,
      );
      this.event(id, null, 'status', { status: 'queued' }, now);
      return { task: this.getTask(id), reused: false };
    });
  }

  private taskRow(id: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!row) throw new PlatformError(404, 'TASK_NOT_FOUND', '任务不存在');
    return row;
  }

  private toTask(row: TaskRow) {
    return {
      task_id: row.id,
      app_id: row.app_id,
      task_key: row.task_key,
      source: row.source,
      schedule_id: row.schedule_id,
      planned_fire_time: row.planned_fire_time === null ? null : new Date(row.planned_fire_time).toISOString(),
      status: row.status,
      progress: row.progress,
      input: parseJson<unknown>(row.input_json),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      queue_deadline_at: new Date(row.queue_deadline_at).toISOString(),
      deadline_at: row.deadline_at === null ? null : new Date(row.deadline_at).toISOString(),
      attempt_count: row.attempt_count,
      max_attempts: row.max_attempts,
      output: row.output_json ? parseJson<unknown>(row.output_json) : null,
      artifact_id: row.final_artifact_id,
      close_reason: row.close_reason,
      closed_at: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
      error: row.error_message,
      error_code: row.error_code,
      retry_of_task_id: row.retry_of_task_id,
    };
  }

  getTask(id: string) {
    return this.toTask(this.taskRow(id));
  }

  listTasks(filters: {
    appId?: string; taskKey?: string; status?: TaskStatus; scheduleId?: string;
    limit?: number; cursor?: string; summary?: boolean;
  } = {}) {
    const limit = filters.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PlatformError(400, 'INVALID_LIMIT', 'limit 必须为 1–100 的整数');
    }
    let position: [number, string] | null = null;
    if (filters.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(decoded) || decoded.length !== 2 ||
          !Number.isSafeInteger(decoded[0]) || typeof decoded[1] !== 'string') {
          throw new Error('invalid cursor');
        }
        position = decoded as [number, string];
      } catch {
        throw new PlatformError(400, 'INVALID_CURSOR', '任务历史游标无效');
      }
    }
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filters.appId) { where.push('app_id = ?'); args.push(filters.appId); }
    if (filters.taskKey) { where.push('task_key = ?'); args.push(filters.taskKey); }
    if (filters.status) { where.push('status = ?'); args.push(filters.status); }
    if (filters.scheduleId) { where.push('schedule_id = ?'); args.push(filters.scheduleId); }
    if (position) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(position[0], position[0], position[1]);
    }
    const columns = filters.summary
      ? `id, app_id, task_key, source, origin_key, input_json, input_hash, idempotency_key,
         schedule_id, planned_fire_time, status, progress, created_at, updated_at, queue_deadline_at,
         deadline_at, attempt_count, max_attempts, current_attempt_id, lease_expires_at,
         final_artifact_id, close_reason, closed_at, closed_by, retry_of_task_id, error_code, error_message,
         CASE WHEN app_id = 'podcast-tools' THEN json_object('inserted', json_extract(output_json, '$.inserted'),
           'updated', json_extract(output_json, '$.updated'), 'failed', json_extract(output_json, '$.failed'))
         ELSE NULL END AS output_json`
      : '*';
    const sql = `SELECT ${columns} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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

  getResult(id: string) {
    const task = this.getTask(id);
    return {
      task_id: task.task_id,
      status: task.status,
      output: task.output,
      artifact_id: task.artifact_id,
      close_reason: task.close_reason,
      error: task.error,
    };
  }

  getEvents(id: string, after = 0) {
    this.taskRow(id);
    const rows = this.db.prepare(`SELECT id, attempt_id, type, payload_json, created_at
      FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 100`).all(id, after) as Array<{
        id: number; attempt_id: string | null; type: string; payload_json: string; created_at: number;
      }>;
    return rows.map((row) => ({
      id: row.id,
      attempt_id: row.attempt_id,
      type: row.type,
      payload: parseJson<unknown>(row.payload_json),
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  getLogs(id: string, after = 0) {
    this.taskRow(id);
    const rows = this.db.prepare(`SELECT id, attempt_id, payload_json, created_at
      FROM task_events WHERE task_id = ? AND type = 'log' AND id > ? ORDER BY id LIMIT 100`)
      .all(id, after) as Array<{ id: number; attempt_id: string | null; payload_json: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      attempt_id: row.attempt_id,
      ...(parseJson<{ level: string; message: string }>(row.payload_json)),
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  log(taskId: string, attemptId: string, appId: string, level: string, message: string): void {
    message = redactText(message);
    this.transaction(() => {
      this.currentAttempt(taskId, attemptId, appId);
      this.event(taskId, attemptId, 'log', { level, message });
    });
  }

  // ---------- 租约与执行 ----------

  lease(appId: string, leaseMs = this.leaseMs): {
    task_id: string; attempt_id: string; app_id: string; task_key: string;
    input: unknown; steps: Record<string, unknown>; deadline_at: string;
    schedule_id: string | null; planned_fire_time: string | null;
  } | null {
    return this.transaction(() => {
      const app = this.db.prepare('SELECT * FROM apps WHERE app_id = ?').get(appId) as AppRow | undefined;
      if (!app) throw new PlatformError(403, 'WORKER_APP_UNKNOWN', 'Worker 应用不存在');
      const active = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks
        WHERE app_id = ? AND status = 'running'`).get(appId) as { count: number };
      if (active.count >= app.max_concurrency) return null;
      const now = Date.now();
      const row = this.db.prepare(`SELECT t.*, d.execution_timeout_ms, d.queue_timeout_ms
        FROM tasks t JOIN task_definitions d ON d.app_id = t.app_id AND d.task_key = t.task_key
        WHERE t.app_id = ? AND d.enabled = 1
          AND t.status IN ('queued', 'recovering')
          AND t.attempt_count < t.max_attempts
          AND t.queue_deadline_at > ?
        ORDER BY t.created_at ASC, t.id ASC LIMIT 1`)
        .get(appId, now) as (TaskRow & { execution_timeout_ms: number; queue_timeout_ms: number }) | undefined;
      if (!row) return null;
      const attemptId = randomUUID();
      const attemptNumber = row.attempt_count + 1;
      const deadlineAt = now + row.execution_timeout_ms;
      const leaseExpiresAt = Math.min(now + leaseMs, deadlineAt);
      this.db.prepare(`UPDATE tasks SET status = 'running', current_attempt_id = ?,
        attempt_count = ?, deadline_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?`).run(attemptId, attemptNumber, deadlineAt, leaseExpiresAt, now, row.id);
      this.db.prepare(`INSERT INTO task_attempts(id, task_id, attempt_number, status, started_at)
        VALUES (?, ?, ?, 'running', ?)`).run(attemptId, row.id, attemptNumber, now);
      this.event(row.id, attemptId, 'status', { status: 'running', attempt_number: attemptNumber }, now);
      const steps = this.db.prepare('SELECT step_key, value_json FROM task_steps WHERE task_id = ?')
        .all(row.id) as Array<{ step_key: string; value_json: string }>;
      return {
        task_id: row.id,
        attempt_id: attemptId,
        app_id: row.app_id,
        task_key: row.task_key,
        input: parseJson<unknown>(row.input_json),
        steps: Object.fromEntries(steps.map((step) => [step.step_key, parseJson<unknown>(step.value_json)])),
        deadline_at: new Date(deadlineAt).toISOString(),
        schedule_id: row.schedule_id,
        planned_fire_time: row.planned_fire_time === null ? null : new Date(row.planned_fire_time).toISOString(),
      };
    });
  }

  private currentAttempt(taskId: string, attemptId: string, appId: string, now = Date.now()): TaskRow {
    const row = this.taskRow(taskId);
    if (row.app_id !== appId) throw new PlatformError(403, 'WRONG_APP', '任务不属于该应用');
    if (row.status !== 'running' || row.current_attempt_id !== attemptId ||
      row.lease_expires_at === null || row.lease_expires_at <= now ||
      row.deadline_at === null || row.deadline_at <= now) {
      throw new PlatformError(409, 'STALE_ATTEMPT', '当前尝试已失去任务租约');
    }
    return row;
  }

  heartbeat(taskId: string, attemptId: string, appId: string, leaseMs = this.leaseMs): void {
    this.transaction(() => {
      this.currentAttempt(taskId, attemptId, appId);
      const now = Date.now();
      const row = this.taskRow(taskId);
      const deadline = row.deadline_at as number;
      this.db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(Math.min(now + leaseMs, deadline), now, taskId);
    });
  }

  progress(taskId: string, attemptId: string, appId: string, progress: number, message: string): void {
    message = redactText(message);
    this.transaction(() => {
      this.currentAttempt(taskId, attemptId, appId);
      const now = Date.now();
      this.db.prepare('UPDATE tasks SET progress = MAX(progress, ?), updated_at = ? WHERE id = ?')
        .run(progress, now, taskId);
      this.event(taskId, attemptId, 'progress', { progress, message }, now);
    });
  }

  saveStep(taskId: string, attemptId: string, appId: string, stepKey: string, value: unknown): void {
    this.transaction(() => {
      this.currentAttempt(taskId, attemptId, appId);
      const existing = this.db.prepare('SELECT value_json FROM task_steps WHERE task_id = ? AND step_key = ?')
        .get(taskId, stepKey) as { value_json: string } | undefined;
      if (existing) {
        if (canonicalJson(parseJson<unknown>(existing.value_json)) !== canonicalJson(value)) {
          throw new PlatformError(409, 'STEP_CONFLICT', '已确认的步骤结果不可修改');
        }
        return;
      }
      const now = Date.now();
      this.db.prepare('INSERT INTO task_steps(task_id, step_key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(taskId, stepKey, JSON.stringify(value), now);
      this.event(taskId, attemptId, 'step', { step_key: stepKey }, now);
    });
  }

  artifactMaxBytes(taskId: string, attemptId: string, appId: string): number {
    const task = this.currentAttempt(taskId, attemptId, appId);
    return this.definitionRow(task.app_id, task.task_key).artifact_max_bytes ?? Infinity;
  }

  createArtifact(taskId: string, attemptId: string, appId: string, id: string, name: string,
    contentType: string, byteSize: number, checksum: string): void {
    this.transaction(() => {
      const limit = this.artifactMaxBytes(taskId, attemptId, appId);
      if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
        throw new PlatformError(400, 'INVALID_ARTIFACT_SIZE', '产物大小必须是非负安全整数');
      }
      if (byteSize > limit) {
        throw new PlatformError(413, 'ARTIFACT_TOO_LARGE', '产物超过任务定义的大小限制');
      }
      this.db.prepare(`INSERT INTO artifacts(id, task_id, attempt_id, name, content_type,
        byte_size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, taskId, attemptId, name, contentType, byteSize, checksum, Date.now(),
      );
      this.event(taskId, attemptId, 'artifact', { artifact_id: id, name });
    });
  }

  complete(taskId: string, attemptId: string, appId: string, output: unknown) {
    return this.transaction(() => {
      const row = this.taskRow(taskId);
      if (row.app_id !== appId) throw new PlatformError(403, 'WRONG_APP', '任务不属于该应用');
      if (row.status === 'succeeded' && row.current_attempt_id === attemptId && row.output_json &&
        canonicalJson(parseJson<unknown>(row.output_json)) === canonicalJson(output)) {
        return this.toTask(row);
      }
      this.currentAttempt(taskId, attemptId, appId);
      const definition = this.definitionRow(row.app_id, row.task_key);
      const issues = validateJsonSchema(parseJson<JsonSchema>(definition.output_schema_json), output);
      if (issues.length > 0) {
        throw new PlatformError(400, 'INVALID_OUTPUT', issues.map((issue) => `${issue.path} ${issue.message}`).join('；'));
      }
      const artifactId = typeof output === 'object' && output !== null && !Array.isArray(output) &&
        'artifact_id' in output ? (output as { artifact_id: unknown }).artifact_id : null;
      if (artifactId !== null) {
        if (typeof artifactId !== 'string') throw new PlatformError(400, 'INVALID_OUTPUT', 'artifact_id 必须是字符串');
        const artifact = this.db.prepare('SELECT id FROM artifacts WHERE id = ? AND task_id = ? AND attempt_id = ?')
          .get(artifactId, taskId, attemptId);
        if (!artifact) throw new PlatformError(400, 'ARTIFACT_NOT_READY', '产物不存在或不属于当前尝试');
      } else if (definition.artifact_required === 1) {
        throw new PlatformError(400, 'INVALID_OUTPUT', '该任务要求必须上传产物');
      }
      const now = Date.now();
      this.db.prepare(`UPDATE tasks SET status = 'succeeded', progress = 100,
        output_json = ?, final_artifact_id = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(output), artifactId, now, taskId);
      this.db.prepare(`UPDATE task_attempts SET status = 'succeeded', finished_at = ? WHERE id = ?`)
        .run(now, attemptId);
      this.event(taskId, attemptId, 'status', { status: 'succeeded' }, now);
      return this.getTask(taskId);
    });
  }

  fail(taskId: string, attemptId: string, appId: string, message: string) {
    message = redactText(message);
    return this.transaction(() => {
      const row = this.taskRow(taskId);
      if (row.app_id !== appId) throw new PlatformError(403, 'WRONG_APP', '任务不属于该应用');
      if (row.status === 'failed' && row.current_attempt_id === attemptId && row.error_message === message) {
        return this.toTask(row);
      }
      this.currentAttempt(taskId, attemptId, appId);
      const now = Date.now();
      this.db.prepare(`UPDATE tasks SET status = 'failed', error_code = 'TASK_FAILED',
        error_message = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(message, now, taskId);
      this.db.prepare(`UPDATE task_attempts SET status = 'failed', finished_at = ? WHERE id = ?`)
        .run(now, attemptId);
      this.event(taskId, attemptId, 'status', { status: 'failed', error: message }, now);
      return this.getTask(taskId);
    });
  }

  // ---------- 手动操作 ----------

  close(taskId: string, closedBy: string, reason: string) {
    reason = redactText(reason);
    return this.transaction(() => {
      const row = this.taskRow(taskId);
      if (row.status === 'closed') return this.toTask(row);
      if (row.status === 'succeeded' || row.status === 'failed') {
        throw new PlatformError(409, 'TASK_TERMINAL', '任务已结束，不能关闭');
      }
      const now = Date.now();
      this.db.prepare(`UPDATE tasks SET status = 'closed', close_reason = ?, closed_at = ?,
        closed_by = ?, current_attempt_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(reason, now, closedBy, now, taskId);
      if (row.current_attempt_id) {
        this.db.prepare(`UPDATE task_attempts SET status = 'closed', finished_at = ?,
          reason = ? WHERE id = ?`).run(now, 'manual', row.current_attempt_id);
      }
      this.event(taskId, row.current_attempt_id, 'status', { status: 'closed', reason }, now);
      return this.getTask(taskId);
    });
  }

  retry(taskId: string, originKey: string) {
    return this.transaction(() => {
      const original = this.taskRow(taskId);
      if (original.status !== 'failed' && original.status !== 'closed') {
        throw new PlatformError(409, 'TASK_NOT_RETRYABLE', '只有失败或已关闭的任务可以重试');
      }
      const definition = this.definitionRow(original.app_id, original.task_key, { enabledOnly: true });
      this.validateInput(definition, parseJson<unknown>(original.input_json));
      const now = Date.now();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO tasks(
        id, app_id, task_key, source, origin_key, input_json, input_hash, idempotency_key,
        status, progress, created_at, updated_at, queue_deadline_at, max_attempts, retry_of_task_id
      ) VALUES (?, ?, ?, 'manual', ?, ?, ?, NULL, 'queued', 0, ?, ?, ?, ?, ?)`).run(
        id, original.app_id, original.task_key, originKey, original.input_json, original.input_hash,
        now, now, now + definition.queue_timeout_ms, definition.max_attempts, original.id,
      );
      this.event(id, null, 'status', { status: 'queued', retry_of_task_id: original.id }, now);
      return this.getTask(id);
    });
  }

  // ---------- 调度 ----------

  private validateCron(expression: string): void {
    try { parseCron(expression); }
    catch (error) {
      throw new PlatformError(400, 'INVALID_CRON', error instanceof Error ? error.message : 'cron 表达式无效');
    }
  }

  createSchedule(appId: string, taskKey: string, input: unknown, cronExpression: string,
    timezone: string, enabled = true): ReturnType<Store['toSchedule']> {
    const definition = this.definitionRow(appId, taskKey, { enabledOnly: true });
    if (definition.schedulable !== 1) {
      throw new PlatformError(400, 'TASK_NOT_SCHEDULABLE', '该任务定义不允许调度');
    }
    const inputValue = input === undefined ? {} : input;
    const inputJson = this.validateInput(definition, inputValue);
    this.validateCron(cronExpression);
    if (!validateTimezone(timezone)) throw new PlatformError(400, 'INVALID_TIMEZONE', '时区无效');
    const now = Date.now();
    const next = enabled ? nextFire(cronExpression, timezone, now) : null;
    if (enabled && next === null) {
      throw new PlatformError(400, 'INVALID_CRON', '无法计算下一次触发时间');
    }
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare(`INSERT INTO schedules(id, app_id, task_key, input_json, cron_expression,
        timezone, enabled, next_fire_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, appId, taskKey, inputJson, cronExpression.trim(), timezone,
        enabled ? 1 : 0, next, now, now,
      );
      return this.getSchedule(id);
    });
  }

  private toSchedule(row: ScheduleRow) {
    return {
      schedule_id: row.id,
      app_id: row.app_id,
      task_key: row.task_key,
      input: parseJson<unknown>(row.input_json),
      cron: row.cron_expression,
      timezone: row.timezone,
      enabled: row.enabled === 1,
      next_fire_at: row.next_fire_at === null ? null : new Date(row.next_fire_at).toISOString(),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  private scheduleRow(id: string): ScheduleRow {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!row) throw new PlatformError(404, 'SCHEDULE_NOT_FOUND', '调度不存在');
    return row;
  }

  getSchedule(id: string) {
    return this.toSchedule(this.scheduleRow(id));
  }

  listSchedules(): Array<ReturnType<Store['toSchedule']>> {
    const rows = this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC, id DESC')
      .all() as ScheduleRow[];
    return rows.map((row) => this.toSchedule(row));
  }

  updateSchedule(id: string, patch: {
    input?: unknown; cron?: string; timezone?: string; enabled?: boolean;
  }): ReturnType<Store['toSchedule']> {
    return this.transaction(() => {
      const row = this.scheduleRow(id);
      const definition = this.definitionRow(row.app_id, row.task_key);
      const inputValue = patch.input === undefined ? parseJson<unknown>(row.input_json) : patch.input;
      const inputJson = this.validateInput(definition, inputValue);
      const cronExpression = patch.cron === undefined ? row.cron_expression : patch.cron.trim();
      const timezone = patch.timezone === undefined ? row.timezone : patch.timezone;
      this.validateCron(cronExpression);
      if (!validateTimezone(timezone)) throw new PlatformError(400, 'INVALID_TIMEZONE', '时区无效');
      const enabled = patch.enabled === undefined ? row.enabled === 1 : patch.enabled;
      const now = Date.now();
      const changedSchedule = cronExpression !== row.cron_expression || timezone !== row.timezone;
      let next = row.next_fire_at;
      if (!enabled) next = null;
      else if (changedSchedule || row.enabled === 0 || next === null || next <= now) {
        next = nextFire(cronExpression, timezone, now);
        if (next === null) throw new PlatformError(400, 'INVALID_CRON', '无法计算下一次触发时间');
      }
      this.db.prepare(`UPDATE schedules SET input_json = ?, cron_expression = ?, timezone = ?,
        enabled = ?, next_fire_at = ?, updated_at = ? WHERE id = ?`).run(
        inputJson, cronExpression, timezone, enabled ? 1 : 0, next, now, id,
      );
      return this.getSchedule(id);
    });
  }

  deleteSchedule(id: string): void {
    this.transaction(() => {
      this.scheduleRow(id);
      this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    });
  }

  listScheduleRuns(scheduleId: string): Array<{
    planned_fire_time: string; status: string; task_id: string | null; reason: string | null; created_at: string;
  }> {
    this.scheduleRow(scheduleId);
    const rows = this.db.prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`).all(scheduleId) as ScheduleRunRow[];
    return rows.map((row) => ({
      planned_fire_time: new Date(row.planned_fire_time).toISOString(),
      status: row.status,
      task_id: row.task_id,
      reason: row.reason,
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  runScheduleNow(id: string): { task: ReturnType<Store['getTask']> | null; skipped?: string } {
    return this.transaction(() => {
      const schedule = this.scheduleRow(id);
      const now = Date.now();
      if (this.activeScheduleTask(id)) {
        this.insertScheduleRun(id, now, 'skipped_overlap', null, 'run_now', now);
        return { task: null, skipped: 'overlap' };
      }
      const task = this.createScheduledTask(schedule, now, now);
      if (!task) return { task: null, skipped: 'failed' };
      return { task };
    });
  }

  private activeScheduleTask(scheduleId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 AS ok FROM tasks WHERE schedule_id = ?
      AND status IN ('queued', 'running', 'recovering') LIMIT 1`).get(scheduleId));
  }

  private insertScheduleRun(scheduleId: string, plannedFireTime: number, status: string,
    taskId: string | null, reason: string | null, now: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO schedule_runs(
      id, schedule_id, planned_fire_time, status, task_id, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), scheduleId, plannedFireTime, status, taskId, reason === null ? null : redactText(reason), now,
    );
  }

  private createScheduledTask(schedule: ScheduleRow, plannedFireTime: number,
    now: number): ReturnType<Store['getTask']> | null {
    const existing = this.db.prepare(`SELECT id FROM tasks WHERE schedule_id = ?
      AND planned_fire_time = ?`).get(schedule.id, plannedFireTime) as { id: string } | undefined;
    if (existing) return null;
    const definition = this.definitionRow(schedule.app_id, schedule.task_key, { enabledOnly: true });
    if (definition.schedulable !== 1) {
      this.insertScheduleRun(schedule.id, plannedFireTime, 'failed', null, 'task_not_schedulable', now);
      return null;
    }
    const input = parseJson<unknown>(schedule.input_json);
    let inputJson: string;
    try { inputJson = this.validateInput(definition, input); }
    catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      this.insertScheduleRun(schedule.id, plannedFireTime, 'failed', null,
        `${error.code}: ${error.message}`, now);
      return null;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO tasks(
      id, app_id, task_key, source, schedule_id, planned_fire_time, origin_key,
      input_json, input_hash, idempotency_key, status, progress, created_at, updated_at,
      queue_deadline_at, max_attempts
    ) VALUES (?, ?, ?, 'schedule', ?, ?, ?, ?, ?, NULL, 'queued', 0, ?, ?, ?, ?)`).run(
      id, schedule.app_id, schedule.task_key, schedule.id, plannedFireTime,
      `schedule:${schedule.id}`, inputJson, sha256(canonicalJson(input)),
      now, now, now + definition.queue_timeout_ms, definition.max_attempts,
    );
    this.event(id, null, 'status', {
      status: 'queued', schedule_id: schedule.id,
      planned_fire_time: new Date(plannedFireTime).toISOString(),
    }, now);
    this.insertScheduleRun(schedule.id, plannedFireTime, 'created', id, null, now);
    return this.getTask(id);
  }

  private advanceSchedule(schedule: ScheduleRow, plannedFireTime: number, now: number): void {
    const next = nextFire(schedule.cron_expression, schedule.timezone, Math.max(plannedFireTime, now));
    this.db.prepare('UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?')
      .run(next, now, schedule.id);
  }

  schedulerTick(now = Date.now(), graceMs = 5 * 60_000): number {
    return this.transaction(() => {
      const due = this.db.prepare(`SELECT * FROM schedules WHERE enabled = 1
        AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC`)
        .all(now) as ScheduleRow[];
      let created = 0;
      for (const schedule of due) {
        const planned = schedule.next_fire_at as number;
        try {
          if (now - planned > graceMs) {
            this.insertScheduleRun(schedule.id, planned, 'skipped_missed', null, 'grace_exceeded', now);
          } else if (this.activeScheduleTask(schedule.id)) {
            this.insertScheduleRun(schedule.id, planned, 'skipped_overlap', null, 'active_task', now);
          } else {
            const task = this.createScheduledTask(schedule, planned, now);
            if (task) created += 1;
          }
          this.advanceSchedule(schedule, planned, now);
        } catch (error) {
          this.insertScheduleRun(schedule.id, planned, 'failed', null,
            diagnosticMessage(error, 500), now);
          this.advanceSchedule(schedule, planned, now);
        }
      }
      return created;
    });
  }

  // ---------- 回收器 ----------

  sweep(now = Date.now()): number {
    return this.transaction(() => {
      let count = 0;

      const queued = this.db.prepare(`SELECT * FROM tasks
        WHERE status IN ('queued', 'recovering') AND queue_deadline_at <= ?`).all(now) as TaskRow[];
      for (const task of queued) {
        this.db.prepare(`UPDATE tasks SET status = 'closed', close_reason = 'QUEUE_TIMEOUT',
          closed_at = ?, current_attempt_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`).run(now, now, task.id);
        if (task.current_attempt_id) {
          this.db.prepare(`UPDATE task_attempts SET status = 'interrupted', finished_at = ?,
            reason = 'queue_timeout' WHERE id = ?`).run(now, task.current_attempt_id);
        }
        this.event(task.id, task.current_attempt_id, 'status',
          { status: 'closed', reason: 'QUEUE_TIMEOUT' }, now);
        count += 1;
      }

      const timedOut = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'
        AND deadline_at IS NOT NULL AND deadline_at <= ?`).all(now) as TaskRow[];
      for (const task of timedOut) {
        this.db.prepare(`UPDATE tasks SET status = 'closed', close_reason = 'TIMEOUT',
          closed_at = ?, current_attempt_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`).run(now, now, task.id);
        if (task.current_attempt_id) {
          this.db.prepare(`UPDATE task_attempts SET status = 'timeout', finished_at = ?,
            reason = 'execution_timeout' WHERE id = ?`).run(now, task.current_attempt_id);
        }
        this.event(task.id, task.current_attempt_id, 'status', { status: 'closed', reason: 'TIMEOUT' }, now);
        count += 1;
      }

      const expired = this.db.prepare(`SELECT t.*, d.queue_timeout_ms FROM tasks t
        LEFT JOIN task_definitions d ON d.app_id = t.app_id AND d.task_key = t.task_key
        WHERE t.status = 'running' AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at <= ?
        AND (t.deadline_at IS NULL OR t.deadline_at > ?)`).all(now, now) as
        Array<TaskRow & { queue_timeout_ms: number | null }>;
      for (const task of expired) {
        if (task.attempt_count >= task.max_attempts) {
          this.db.prepare(`UPDATE tasks SET status = 'closed', close_reason = 'ATTEMPTS_EXHAUSTED',
            closed_at = ?, current_attempt_id = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ?`).run(now, now, task.id);
          if (task.current_attempt_id) {
            this.db.prepare(`UPDATE task_attempts SET status = 'interrupted', finished_at = ?,
              reason = 'attempts_exhausted' WHERE id = ?`).run(now, task.current_attempt_id);
          }
          this.event(task.id, task.current_attempt_id, 'status',
            { status: 'closed', reason: 'ATTEMPTS_EXHAUSTED' }, now);
        } else {
          const queueTimeout = task.queue_timeout_ms ?? 3_600_000;
          this.db.prepare(`UPDATE tasks SET status = 'recovering', current_attempt_id = NULL,
            lease_expires_at = NULL, queue_deadline_at = ?, updated_at = ? WHERE id = ?`)
            .run(now + queueTimeout, now, task.id);
          if (task.current_attempt_id) {
            this.db.prepare(`UPDATE task_attempts SET status = 'interrupted', finished_at = ?,
              reason = 'lease_expired' WHERE id = ?`).run(now, task.current_attempt_id);
          }
          this.event(task.id, task.current_attempt_id, 'status',
            { status: 'recovering', reason: 'lease_expired' }, now);
        }
        count += 1;
      }

      return count;
    });
  }

  // ---------- 产物 ----------

  getArtifactForDownload(id: string): ArtifactRow {
    const row = this.db.prepare(`SELECT a.* FROM artifacts a JOIN tasks t ON t.id = a.task_id
      WHERE a.id = ? AND t.status = 'succeeded' AND t.final_artifact_id = a.id`)
      .get(id) as ArtifactRow | undefined;
    if (!row) throw new PlatformError(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    return row;
  }
}
