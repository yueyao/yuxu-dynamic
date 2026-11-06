/** 转写应用领域表：与平台共用 SQLite，只读写 transcription_ 前缀表。 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TranscriptSegment = { start: number; end: number; text: string };

export type TranscriptRecord = {
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
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
    `);
  }

  close(): void {
    this.db.close();
  }

  save(input: {
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
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM transcription_transcripts WHERE task_id = ?')
      .get(input.taskId) as TranscriptRow | undefined;
    const id = existing?.id ?? `transcript-${randomUUID()}`;
    this.db.prepare(`INSERT INTO transcription_transcripts(
      id, task_id, episode_id, show_id, title, language, provider, model,
      duration_seconds, text, segments_json, artifact_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      artifact_id = excluded.artifact_id,
      text = excluded.text,
      segments_json = excluded.segments_json,
      duration_seconds = excluded.duration_seconds`).run(
      id, input.taskId, input.episodeId ?? null, input.showId ?? null,
      input.title ?? null, input.language, input.provider, input.model,
      input.durationSeconds, input.text, JSON.stringify(input.segments),
      input.artifactId, existing?.created_at ?? now,
    );
    return this.getByTask(input.taskId) as TranscriptRecord;
  }

  private toRecord(row: TranscriptRow): TranscriptRecord {
    return {
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

  getByEpisode(episodeId: string): TranscriptRecord | null {
    const row = this.db.prepare(`SELECT * FROM transcription_transcripts
      WHERE episode_id = ? ORDER BY created_at DESC LIMIT 1`).get(episodeId) as TranscriptRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  list(limit = 20): TranscriptRecord[] {
    const safe = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    const rows = this.db.prepare('SELECT * FROM transcription_transcripts ORDER BY created_at DESC LIMIT ?')
      .all(safe) as TranscriptRow[];
    return rows.map((row) => this.toRecord(row));
  }
}
