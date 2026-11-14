/** 转写应用领域表：与平台共用 SQLite，只读写 transcription_ 前缀表。 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TranscriptContractError, validateTranscript, type TranscriptVersion, type TranscriptSegment,
  type DiarizationMetadata } from './contract.ts';

export type { TranscriptSegment, TranscriptVersion, DiarizationMetadata } from './contract.ts';

export type TranscriptRecord = {
  version: TranscriptVersion;
  diarization: DiarizationMetadata | null;
  transcript_id: string;
  task_id: string;
  episode_id: string | null;
  show_id: string | null;
  title: string | null;
  language: string;
  provider: string;
  model: string;
  duration_seconds: number | null;
  text: string;
  segments: TranscriptSegment[];
  artifact_id: string | null;
  created_at: string;
};

type TranscriptRow = {
  version: TranscriptVersion; diarization_json: string | null;
  id: string; task_id: string; episode_id: string | null; show_id: string | null;
  title: string | null; language: string; provider: string; model: string;
  duration_seconds: number | null; text: string; segments_json: string;
  artifact_id: string | null; created_at: number;
};

export class TranscriptionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS transcription_transcripts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        episode_id TEXT,
        show_id TEXT,
        title TEXT,
        language TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        duration_seconds REAL,
        text TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        artifact_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcription_transcripts_episode
        ON transcription_transcripts(episode_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS transcription_transcripts_history ON transcription_transcripts(created_at DESC, id DESC);
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(transcription_transcripts)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'version')) {
        this.db.exec('ALTER TABLE transcription_transcripts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version IN (1, 2))');
      }
      if (!columns.some((column) => column.name === 'diarization_json')) {
        this.db.exec('ALTER TABLE transcription_transcripts ADD COLUMN diarization_json TEXT');
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS transcription_transcripts_version
        ON transcription_transcripts(episode_id, version DESC, created_at DESC, id DESC)`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }

  save(input: {
    version?: TranscriptVersion;
    diarization?: DiarizationMetadata | null;
    taskId: string;
    episodeId?: string | null;
    showId?: string | null;
    title?: string | null;
    language: string;
    provider: string;
    model: string;
    durationSeconds: number | null;
    text: string;
    segments: TranscriptSegment[];
    artifactId: string | null;
  }): TranscriptRecord {
    const version = validateTranscript(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM transcription_transcripts WHERE task_id = ?')
      .get(input.taskId) as TranscriptRow | undefined;
    if (existing && existing.version !== version) {
      throw new TranscriptContractError('TRANSCRIPT_VERSION_CONFLICT: 同一任务不能更改稿件版本，请新建任务');
    }
    const id = existing?.id ?? `transcript-${randomUUID()}`;
    this.db.prepare(`INSERT INTO transcription_transcripts(
      id, task_id, episode_id, show_id, title, language, provider, model,
      duration_seconds, text, segments_json, artifact_id, created_at, version, diarization_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      artifact_id = excluded.artifact_id,
      text = excluded.text,
      segments_json = excluded.segments_json,
      duration_seconds = excluded.duration_seconds,
      diarization_json = excluded.diarization_json`).run(
      id, input.taskId, input.episodeId ?? null, input.showId ?? null,
      input.title ?? null, input.language, input.provider, input.model,
      input.durationSeconds, input.text, JSON.stringify(input.segments),
      input.artifactId, existing?.created_at ?? now, version,
      version === 2 ? JSON.stringify(input.diarization) : null,
    );
    this.db.exec('COMMIT');
    return this.getByTask(input.taskId) as TranscriptRecord;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  private toRecord(row: TranscriptRow): TranscriptRecord {
    return {
      version: row.version,
      diarization: row.diarization_json ? JSON.parse(row.diarization_json) as DiarizationMetadata : null,
      transcript_id: row.id,
      task_id: row.task_id,
      episode_id: row.episode_id,
      show_id: row.show_id,
      title: row.title,
      language: row.language,
      provider: row.provider,
      model: row.model,
      duration_seconds: row.duration_seconds,
      text: row.text,
      segments: JSON.parse(row.segments_json) as TranscriptSegment[],
      artifact_id: row.artifact_id,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  getByTask(taskId: string): TranscriptRecord | null {
    const row = this.db.prepare('SELECT * FROM transcription_transcripts WHERE task_id = ?')
      .get(taskId) as TranscriptRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  getByEpisode(episodeId: string, version?: TranscriptVersion): TranscriptRecord | null {
    const row = this.db.prepare(`SELECT * FROM transcription_transcripts
      WHERE episode_id = ? ${version ? 'AND version = ?' : ''}
      ORDER BY version DESC, created_at DESC, id DESC LIMIT 1`)
      .get(...(version ? [episodeId, version] : [episodeId])) as TranscriptRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  availableVersions(episodeId: string): TranscriptVersion[] {
    return (this.db.prepare('SELECT DISTINCT version FROM transcription_transcripts WHERE episode_id = ? ORDER BY version')
      .all(episodeId) as Array<{ version: TranscriptVersion }>).map((row) => row.version);
  }

  list(limit = 20): TranscriptRecord[] {
    const safe = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    const rows = this.db.prepare('SELECT * FROM transcription_transcripts ORDER BY created_at DESC LIMIT ?')
      .all(safe) as TranscriptRow[];
    return rows.map((row) => this.toRecord(row));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM transcription_transcripts').get() as
      { count: number };
    return row.count;
  }

  getById(id: string): TranscriptRecord | null {
    const row = this.db.prepare('SELECT * FROM transcription_transcripts WHERE id = ?')
      .get(id) as TranscriptRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  listPage(options: {
    limit?: number; offset?: number; showId?: string; episodeId?: string; query?: string; version?: TranscriptVersion;
  } = {}): { items: TranscriptRecord[]; next_offset: number | null } {
    const limit = Number.isSafeInteger(options.limit)
      ? Math.min(Math.max(options.limit as number, 1), 100) : 20;
    const offset = Number.isSafeInteger(options.offset)
      ? Math.max(options.offset as number, 0) : 0;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.version) { clauses.push('version = ?'); params.push(options.version); }
    if (options.showId) { clauses.push('show_id = ?'); params.push(options.showId); }
    if (options.episodeId) { clauses.push('episode_id = ?'); params.push(options.episodeId); }
    if (options.query) {
      clauses.push('(title LIKE ? OR episode_id LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM transcription_transcripts ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as TranscriptRow[];
    return {
      items: rows.map((row) => this.toRecord(row)),
      next_offset: rows.length === limit ? offset + limit : null,
    };
  }

  listMetadataPage(options: Parameters<TranscriptionStore['listPage']>[0] = {}) {
    const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit!, 1), 100) : 20;
    const offset = Number.isSafeInteger(options.offset) ? Math.max(options.offset!, 0) : 0;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.version) { clauses.push('version = ?'); params.push(options.version); }
    if (options.showId) { clauses.push('show_id = ?'); params.push(options.showId); }
    if (options.episodeId) { clauses.push('episode_id = ?'); params.push(options.episodeId); }
    if (options.query) {
      clauses.push('(title LIKE ? OR episode_id LIKE ?)');
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM transcription_transcripts ${where}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(`SELECT id AS transcript_id, task_id, episode_id, show_id, title, language, version,
      provider, model, duration_seconds, json_array_length(segments_json) AS segments, created_at
      FROM transcription_transcripts ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Omit<TranscriptRecord, 'text' | 'segments' | 'artifact_id' | 'created_at' | 'diarization'> & { segments: number; created_at: number }>;
    return { items: rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
      total, next_offset: offset + rows.length < total ? offset + limit : null };
  }
}
