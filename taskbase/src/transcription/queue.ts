/** 转写队列：Web 端勾选、排序、启停；Worker 仍只从平台领取任务。 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type QueueStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';

export type QueueItem = {
  id: string;
  show_id: string;
  title: string;
  audio_url: string;
  position: number;
  enabled: boolean;
  status: QueueStatus;
  task_id: string | null;
  progress: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

type QueueRow = {
  id: string; show_id: string; title: string; audio_url: string; position: number;
  enabled: number; status: QueueStatus; task_id: string | null; progress: number;
  error: string | null; created_at: number; updated_at: number;
  started_at: number | null; finished_at: number | null;
};

function toItem(row: QueueRow): QueueItem {
  return {
    ...row,
    enabled: row.enabled === 1,
  };
}

export class TranscriptionQueueStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS transcription_queue (
        id TEXT PRIMARY KEY,
        show_id TEXT NOT NULL,
        title TEXT NOT NULL,
        audio_url TEXT NOT NULL,
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        task_id TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS transcription_queue_position
        ON transcription_queue(position);
      CREATE TABLE IF NOT EXISTS transcription_queue_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  list(): QueueItem[] {
    const rows = this.db.prepare('SELECT * FROM transcription_queue ORDER BY position ASC, created_at ASC')
      .all() as QueueRow[];
    return rows.map(toItem);
  }

  get(id: string): QueueItem | null {
    const row = this.db.prepare('SELECT * FROM transcription_queue WHERE id = ?').get(id) as QueueRow | undefined;
    return row ? toItem(row) : null;
  }

  add(items: Array<{ episode_id: string; show_id: string; title: string; audio_url: string }>): {
    added: number; skipped: number;
  } {
    const now = Date.now();
    let added = 0;
    let skipped = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let position = (this.db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM transcription_queue')
        .get() as { max: number }).max;
      const exists = this.db.prepare('SELECT 1 FROM transcription_queue WHERE id = ?');
      const insert = this.db.prepare(`INSERT INTO transcription_queue
        (id, show_id, title, audio_url, position, enabled, status, progress, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 'pending', 0, ?, ?)`);
      for (const item of items) {
        if (!item.episode_id || !item.audio_url) { skipped += 1; continue; }
        if (exists.get(item.episode_id)) { skipped += 1; continue; }
        position += 1;
        insert.run(item.episode_id, item.show_id, item.title, item.audio_url, position, now, now);
        added += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { added, skipped };
  }

  remove(id: string): boolean {
    const item = this.get(id);
    if (!item) return false;
    if (item.status === 'running') throw new Error('任务运行中，不能直接从队列删除');
    return this.db.prepare('DELETE FROM transcription_queue WHERE id = ?').run(id).changes > 0;
  }

  setEnabled(id: string, enabled: boolean): QueueItem | null {
    this.db.prepare('UPDATE transcription_queue SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return this.get(id);
  }

  move(id: string, direction: 'up' | 'down' | 'top'): boolean {
    const current = this.get(id);
    if (!current) return false;
    if (direction === 'top') {
      const minimum = this.db.prepare('SELECT MIN(position) AS min FROM transcription_queue')
        .get() as { min: number | null };
      this.db.prepare('UPDATE transcription_queue SET position = ?, updated_at = ? WHERE id = ?')
        .run((minimum.min ?? current.position) - 1, Date.now(), id);
      return true;
    }
    const neighbor = direction === 'up'
      ? this.db.prepare('SELECT * FROM transcription_queue WHERE position < ? ORDER BY position DESC LIMIT 1')
        .get(current.position)
      : this.db.prepare('SELECT * FROM transcription_queue WHERE position > ? ORDER BY position ASC LIMIT 1')
        .get(current.position);
    if (!neighbor) return false;
    const other = neighbor as QueueRow;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare('UPDATE transcription_queue SET position = ?, updated_at = ? WHERE id = ?');
      update.run(other.position, Date.now(), current.id);
      update.run(current.position, Date.now(), other.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  next(): QueueItem | null {
    const row = this.db.prepare(`SELECT * FROM transcription_queue
      WHERE status = 'pending' AND enabled = 1 ORDER BY position ASC LIMIT 1`).get() as QueueRow | undefined;
    return row ? toItem(row) : null;
  }

  running(): QueueItem | null {
    const row = this.db.prepare("SELECT * FROM transcription_queue WHERE status = 'running' ORDER BY started_at ASC LIMIT 1")
      .get() as QueueRow | undefined;
    return row ? toItem(row) : null;
  }

  markRunning(id: string, taskId: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE transcription_queue
      SET status = 'running', task_id = ?, progress = 0, error = NULL,
          started_at = ?, finished_at = NULL, updated_at = ? WHERE id = ?`)
      .run(taskId, now, now, id);
  }

  updateProgress(id: string, progress: number): void {
    const safe = Math.max(0, Math.min(100, Math.round(progress)));
    this.db.prepare('UPDATE transcription_queue SET progress = ?, updated_at = ? WHERE id = ?')
      .run(safe, Date.now(), id);
  }

  markDone(id: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE transcription_queue
      SET status = 'done', progress = 100, error = NULL, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
  }

  markFailed(id: string, error: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE transcription_queue
      SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(error.slice(0, 1000), now, now, id);
  }

  markCanceled(id: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE transcription_queue
      SET status = 'canceled', progress = 0, error = '已取消', finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
  }

  retry(id: string): QueueItem | null {
    const item = this.get(id);
    if (!item) return null;
    if (item.status === 'running') throw new Error('任务运行中，不能重试');
    this.db.prepare(`UPDATE transcription_queue
      SET status = 'pending', task_id = NULL, progress = 0, error = NULL,
          started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
    return this.get(id);
  }

  clearFinished(): number {
    const result = this.db.prepare("DELETE FROM transcription_queue WHERE status IN ('done', 'failed', 'canceled')")
      .run();
    return Number(result.changes);
  }

  counts(): Record<QueueStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM transcription_queue GROUP BY status')
      .all() as Array<{ status: QueueStatus; count: number }>;
    const counts: Record<QueueStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, canceled: 0 };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM transcription_queue_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? row.value : null;
  }

  setState(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM transcription_queue_state WHERE key = ?').run(key);
      return;
    }
    this.db.prepare(`INSERT INTO transcription_queue_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
}
