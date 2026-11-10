/** 单集身份独立于采集来源；旧 ID 保留为别名，历史链接继续可读。 */
import type { DatabaseSync } from 'node:sqlite';

export function sourceIdentity(value: string): string {
  const match = value.match(/^https?:\/\/(?:www\.)?xiaoyuzhoufm\.com\/episode\/([^/?#]+)/);
  return match ? match[1] : value;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function merge(db: DatabaseSync, oldId: string, canonicalId: string): void {
  if (hasTable(db, 'transcription_transcripts')) {
    db.prepare('UPDATE transcription_transcripts SET episode_id = ? WHERE episode_id = ?').run(canonicalId, oldId);
  }
  if (hasTable(db, 'transcription_queue')) {
    const old = db.prepare('SELECT status FROM transcription_queue WHERE id = ?').get(oldId) as { status: string } | undefined;
    const current = db.prepare('SELECT status FROM transcription_queue WHERE id = ?').get(canonicalId) as { status: string } | undefined;
    if (old && !current) {
      db.prepare('UPDATE transcription_queue SET id = ? WHERE id = ?').run(canonicalId, oldId);
    } else if (old && current) {
      // 两个已提交任务都必须继续跟踪；Runner 保存时会归一到 canonical ID。
      if (old.status === 'running' && current.status === 'running') {
        // 保留两条在途任务，不能丢失 task_id。
      } else if (old.status === 'running') {
        db.prepare('DELETE FROM transcription_queue WHERE id = ?').run(canonicalId);
        db.prepare('UPDATE transcription_queue SET id = ? WHERE id = ?').run(canonicalId, oldId);
      } else {
        db.prepare('DELETE FROM transcription_queue WHERE id = ?').run(oldId);
      }
    }
  }
  db.prepare('UPDATE podcast_episode_aliases SET episode_id = ? WHERE episode_id = ?').run(canonicalId, oldId);
  db.prepare('DELETE FROM podcast_episodes WHERE id = ?').run(oldId);
}

export function migrateEpisodeIdentity(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS podcast_episode_aliases (
    alias_id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
    show_id TEXT NOT NULL,
    identity_key TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS podcast_episode_alias_identity ON podcast_episode_aliases(show_id, identity_key);
  CREATE INDEX IF NOT EXISTS podcast_episode_audio ON podcast_episodes(show_id, audio_url);`);
  if (db.prepare('SELECT 1 FROM podcast_migrations WHERE version = 2').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare('SELECT id, show_id, source_id, audio_url FROM podcast_episodes ORDER BY created_at ASC, id ASC')
      .all() as Array<{ id: string; show_id: string; source_id: string; audio_url: string | null }>;
    for (const row of rows) {
      const key = sourceIdentity(row.source_id);
      const existing = db.prepare(`SELECT episode_id FROM podcast_episode_aliases WHERE show_id = ?
        AND (identity_key = ? OR episode_id IN (SELECT id FROM podcast_episodes WHERE show_id = ? AND audio_url = ?))
        LIMIT 1`).get(row.show_id, key, row.show_id, row.audio_url) as { episode_id: string } | undefined;
      db.prepare('INSERT OR IGNORE INTO podcast_episode_aliases VALUES (?, ?, ?, ?)')
        .run(row.id, row.id, row.show_id, key);
      if (existing && existing.episode_id !== row.id) merge(db, row.id, existing.episode_id);
    }
    db.prepare('INSERT OR IGNORE INTO podcast_migrations VALUES (2, ?)').run(Date.now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
