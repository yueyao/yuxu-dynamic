/**
 * 播客应用的领域表。与平台共用同一个 SQLite 文件，但只读写 podcast_ 前缀表；
 * 平台不读取这些表，备份随平台数据库一起完成。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PodcastShow = {
  show_id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  rss_url: string | null;
  total_episode_count: number | null;
  page_episode_count: number | null;
  coverage_status: string;
  episode_count: number;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_error: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PodcastEpisode = {
  episode_id: string;
  show_id: string;
  source: string;
  source_id: string;
  title: string;
  description: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  audio_url: string | null;
  image_url: string | null;
};

export type PodcastRun = {
  run_id: string;
  task_id: string | null;
  show_id: string | null;
  show_title: string | null;
  since: string | null;
  until: string | null;
  status: string;
  page_episode_count: number | null;
  inserted_count: number;
  updated_count: number;
  coverage_status: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type ParsedEpisode = {
  sourceId: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  audioUrl: string | null;
  imageUrl: string | null;
};

type ShowRow = {
  id: string; url: string; title: string; author: string | null; description: string | null;
  cover_url: string | null; rss_url: string | null; total_episode_count: number | null;
  page_episode_count: number | null; coverage_status: string; last_sync_at: number | null;
  last_sync_status: string | null; last_error: string | null; archived_at: number | null;
  created_at: number; updated_at: number;
};

type EpisodeRow = {
  id: string; show_id: string; source: string; source_id: string; title: string;
  description: string | null; published_at: string | null; duration_seconds: number | null;
  audio_url: string | null; image_url: string | null;
};

type RunRow = {
  id: string; task_id: string | null; show_id: string | null; show_title: string | null;
  since: string | null; until: string | null; status: string; page_episode_count: number | null;
  inserted_count: number; updated_count: number; coverage_status: string | null;
  error: string | null; started_at: number; finished_at: number | null;
};

export class PodcastError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function normalizeShowUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PodcastError(400, 'INVALID_SHOW_URL', '节目链接不是有效的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PodcastError(400, 'INVALID_SHOW_URL', '节目链接必须是 http(s)');
  }
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function normalizeRssUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PodcastError(400, 'INVALID_RSS_URL', 'RSS 链接不是有效的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PodcastError(400, 'INVALID_RSS_URL', 'RSS 链接必须是 http(s)');
  }
  return url.toString();
}

function episodeId(showId: string, source: string, sourceId: string): string {
  return createHash('sha256').update(`${showId}|${source}|${sourceId}`).digest('hex');
}

function text(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

export class PodcastStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS podcast_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS podcast_shows (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT,
        description TEXT,
        cover_url TEXT,
        rss_url TEXT,
        total_episode_count INTEGER,
        page_episode_count INTEGER,
        coverage_status TEXT NOT NULL DEFAULT 'unknown',
        last_sync_at INTEGER,
        last_sync_status TEXT,
        last_error TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS podcast_episodes (
        id TEXT PRIMARY KEY,
        show_id TEXT NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        published_at TEXT,
        duration_seconds INTEGER,
        audio_url TEXT,
        image_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(show_id, source, source_id)
      );
      CREATE INDEX IF NOT EXISTS podcast_episodes_show
        ON podcast_episodes(show_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS podcast_ingest_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        show_id TEXT REFERENCES podcast_shows(id) ON DELETE CASCADE,
        since TEXT,
        until TEXT,
        status TEXT NOT NULL,
        page_episode_count INTEGER,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        coverage_status TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS podcast_runs_show
        ON podcast_ingest_runs(show_id, started_at DESC);
      INSERT OR IGNORE INTO podcast_migrations(version, applied_at) VALUES (1, ${Date.now()});
    `);
    const showColumns = this.db.prepare('PRAGMA table_info(podcast_shows)').all() as Array<{ name: string }>;
    if (!showColumns.some((column) => column.name === 'archived_at')) {
      this.db.exec('ALTER TABLE podcast_shows ADD COLUMN archived_at INTEGER');
    }
  }

  close(): void {
    this.db.close();
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

  private showRow(id: string): ShowRow {
    const row = this.db.prepare('SELECT * FROM podcast_shows WHERE id = ?').get(id) as ShowRow | undefined;
    if (!row) throw new PodcastError(404, 'SHOW_NOT_FOUND', '节目不存在');
    return row;
  }

  private toShow(row: ShowRow & { episode_count?: number }): PodcastShow {
    return {
      show_id: row.id,
      url: row.url,
      title: row.title,
      author: row.author,
      description: row.description,
      cover_url: row.cover_url,
      rss_url: row.rss_url,
      total_episode_count: row.total_episode_count,
      page_episode_count: row.page_episode_count,
      coverage_status: row.coverage_status,
      episode_count: row.episode_count ?? 0,
      last_sync_at: iso(row.last_sync_at),
      last_sync_status: row.last_sync_status,
      last_error: row.last_error,
      archived_at: iso(row.archived_at),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  getShow(id: string): PodcastShow {
    const row = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM podcast_episodes e
      WHERE e.show_id = s.id) AS episode_count FROM podcast_shows s WHERE s.id = ?`).get(id) as
      (ShowRow & { episode_count: number }) | undefined;
    if (!row) throw new PodcastError(404, 'SHOW_NOT_FOUND', '节目不存在');
    return this.toShow(row);
  }

  getShowByUrl(url: string): PodcastShow | null {
    const row = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM podcast_episodes e
      WHERE e.show_id = s.id) AS episode_count FROM podcast_shows s WHERE s.url = ?`).get(url) as
      (ShowRow & { episode_count: number }) | undefined;
    return row ? this.toShow(row) : null;
  }

  addShow(input: { url: string; title?: string; rssUrl?: string | null }): PodcastShow {
    const url = normalizeShowUrl(input.url);
    const existing = this.getShowByUrl(url);
    if (existing) throw new PodcastError(409, 'SHOW_EXISTS', '这个节目已经在库中');
    const title = text(input.title, 200) ?? '未命名播客';
    return this.transaction(() => {
      const id = `show-${randomUUID()}`;
      const now = Date.now();
      this.db.prepare(`INSERT INTO podcast_shows(
        id, url, title, rss_url, coverage_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'unknown', ?, ?)`).run(
        id, url, title, normalizeRssUrl(input.rssUrl), now, now,
      );
      return this.getShow(id);
    });
  }

  ensureShowByUrl(url: string, title?: string): PodcastShow {
    const normalized = normalizeShowUrl(url);
    const existing = this.getShowByUrl(normalized);
    if (existing) return existing;
    return this.addShow({ url: normalized, title });
  }

  setArchived(id: string, archived: boolean): PodcastShow {
    this.showRow(id);
    this.db.prepare('UPDATE podcast_shows SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archived ? Date.now() : null, Date.now(), id);
    return this.getShow(id);
  }

  updateShow(id: string, patch: { title?: string; rssUrl?: string | null }): PodcastShow {
    return this.transaction(() => {
      this.showRow(id);
      const fields: string[] = [];
      const args: Array<string | null | number> = [];
      if (patch.title !== undefined) {
        const title = text(patch.title, 200);
        if (!title) throw new PodcastError(400, 'INVALID_TITLE', '标题不能为空');
        fields.push('title = ?');
        args.push(title);
      }
      if (patch.rssUrl !== undefined) {
        fields.push('rss_url = ?');
        args.push(normalizeRssUrl(patch.rssUrl));
      }
      if (fields.length === 0) return this.getShow(id);
      fields.push('updated_at = ?');
      args.push(Date.now(), id);
      this.db.prepare(`UPDATE podcast_shows SET ${fields.join(', ')} WHERE id = ?`).run(...args);
      return this.getShow(id);
    });
  }

  updateMetadata(id: string, metadata: {
    title?: string;
    author?: string | null;
    description?: string | null;
    coverUrl?: string | null;
    totalEpisodeCount?: number | null;
    pageEpisodeCount?: number | null;
    coverageStatus?: string;
  }): void {
    this.transaction(() => {
      this.showRow(id);
      const mapping: Array<[string, string, unknown]> = [
        ['title = ?', 'title', text(metadata.title, 200)],
        ['author = ?', 'author', text(metadata.author, 200)],
        ['description = ?', 'description', text(metadata.description, 10000)],
        ['cover_url = ?', 'coverUrl', text(metadata.coverUrl, 2000)],
        ['total_episode_count = ?', 'totalEpisodeCount', metadata.totalEpisodeCount ?? null],
        ['page_episode_count = ?', 'pageEpisodeCount', metadata.pageEpisodeCount ?? null],
        ['coverage_status = ?', 'coverageStatus', metadata.coverageStatus ?? null],
      ];
      const fields: string[] = [];
      const args: unknown[] = [];
      for (const [sql, key, value] of mapping) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)) {
          fields.push(sql);
          args.push(value);
        }
      }
      if (fields.length === 0) return;
      fields.push('updated_at = ?');
      args.push(Date.now(), id);
      this.db.prepare(`UPDATE podcast_shows SET ${fields.join(', ')} WHERE id = ?`).run(...args as Array<string | number | null>);
    });
  }

  markSync(id: string, input: {
    status: 'succeeded' | 'partial' | 'failed';
    error?: string | null;
    coverageStatus?: string;
  }): void {
    const now = Date.now();
    this.db.prepare(`UPDATE podcast_shows SET last_sync_at = ?, last_sync_status = ?,
      last_error = ?, updated_at = ?${input.coverageStatus ? ', coverage_status = ?' : ''} WHERE id = ?`).run(
      now, input.status, input.error ?? null, now,
      ...(input.coverageStatus ? [input.coverageStatus] : []), id,
    );
  }

  upsertEpisodes(showId: string, episodes: ParsedEpisode[], source = 'page'): {
    inserted: number; updated: number;
  } {
    return this.transaction(() => {
      this.showRow(showId);
      const unique = new Map<string, ParsedEpisode>();
      for (const episode of episodes) {
        if (episode.sourceId && episode.title) unique.set(episode.sourceId, episode);
      }
      const existing = new Set<string>();
      const rows = this.db.prepare('SELECT source_id FROM podcast_episodes WHERE show_id = ? AND source = ?')
        .all(showId, source) as Array<{ source_id: string }>;
      for (const row of rows) existing.add(row.source_id);
      const now = Date.now();
      let inserted = 0;
      let updated = 0;
      const statement = this.db.prepare(`INSERT INTO podcast_episodes(
        id, show_id, source, source_id, title, description, published_at,
        duration_seconds, audio_url, image_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        published_at = excluded.published_at,
        duration_seconds = excluded.duration_seconds,
        audio_url = excluded.audio_url,
        image_url = excluded.image_url,
        updated_at = excluded.updated_at`);
      for (const episode of unique.values()) {
        const id = episodeId(showId, source, episode.sourceId);
        statement.run(
          id, showId, source, episode.sourceId, episode.title,
          text(episode.description, 10000), episode.publishedAt,
          episode.durationSeconds, text(episode.audioUrl, 5000), text(episode.imageUrl, 2000),
          now, now,
        );
        if (existing.has(episode.sourceId)) updated += 1;
        else inserted += 1;
      }
      return { inserted, updated };
    });
  }

  recordRun(input: {
    taskId: string | null;
    showId: string | null;
    since: string | null;
    until: string | null;
    status: 'succeeded' | 'partial' | 'failed';
    pageEpisodeCount?: number | null;
    inserted: number;
    updated: number;
    coverageStatus?: string | null;
    error?: string | null;
    startedAt: number;
  }): string {
    const id = `run-${randomUUID()}`;
    this.db.prepare(`INSERT INTO podcast_ingest_runs(
      id, task_id, show_id, since, until, status, page_episode_count,
      inserted_count, updated_count, coverage_status, error, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.taskId, input.showId, input.since, input.until, input.status,
      input.pageEpisodeCount ?? null, input.inserted, input.updated,
      input.coverageStatus ?? null, input.error ?? null, input.startedAt, Date.now(),
    );
    return id;
  }

  listShows(): PodcastShow[] {
    const rows = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM podcast_episodes e
      WHERE e.show_id = s.id) AS episode_count FROM podcast_shows s
      ORDER BY s.created_at DESC, s.id DESC`).all() as Array<ShowRow & { episode_count: number }>;
    return rows.map((row) => this.toShow(row));
  }

  listEpisodes(showId: string, limit = 200): PodcastEpisode[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 200;
    this.showRow(showId);
    const rows = this.db.prepare(`SELECT * FROM podcast_episodes WHERE show_id = ?
      ORDER BY published_at DESC, id DESC LIMIT ?`).all(showId, safeLimit) as EpisodeRow[];
    return rows.map((row) => ({
      episode_id: row.id,
      show_id: row.show_id,
      source: row.source,
      source_id: row.source_id,
      title: row.title,
      description: row.description,
      published_at: row.published_at,
      duration_seconds: row.duration_seconds,
      audio_url: row.audio_url,
      image_url: row.image_url,
    }));
  }

  getEpisode(episodeId: string): (PodcastEpisode & { show_title: string | null }) | null {
    const row = this.db.prepare(`SELECT e.*, s.title AS show_title FROM podcast_episodes e
      LEFT JOIN podcast_shows s ON s.id = e.show_id WHERE e.id = ?`).get(episodeId) as
      (EpisodeRow & { show_title: string | null }) | undefined;
    if (!row) return null;
    return {
      episode_id: row.id,
      show_id: row.show_id,
      source: row.source,
      source_id: row.source_id,
      title: row.title,
      description: row.description,
      published_at: row.published_at,
      duration_seconds: row.duration_seconds,
      audio_url: row.audio_url,
      image_url: row.image_url,
      show_title: row.show_title,
    };
  }

  listRuns(showId?: string, limit = 50): PodcastRun[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
    const rows = showId
      ? this.db.prepare(`SELECT r.*, s.title AS show_title FROM podcast_ingest_runs r
          LEFT JOIN podcast_shows s ON s.id = r.show_id WHERE r.show_id = ?
          ORDER BY r.started_at DESC LIMIT ?`).all(showId, safeLimit)
      : this.db.prepare(`SELECT r.*, s.title AS show_title FROM podcast_ingest_runs r
          LEFT JOIN podcast_shows s ON s.id = r.show_id
          ORDER BY r.started_at DESC LIMIT ?`).all(safeLimit);
    return (rows as RunRow[]).map((row) => ({
      run_id: row.id,
      task_id: row.task_id,
      show_id: row.show_id,
      show_title: row.show_title,
      since: row.since,
      until: row.until,
      status: row.status,
      page_episode_count: row.page_episode_count,
      inserted_count: row.inserted_count,
      updated_count: row.updated_count,
      coverage_status: row.coverage_status,
      error: row.error,
      started_at: new Date(row.started_at).toISOString(),
      finished_at: iso(row.finished_at),
    }));
  }

  overview(): {
    shows: number; episodes: number; partial_shows: number; archived_shows: number;
    last_run_at: string | null;
  } {
    const shows = (this.db.prepare('SELECT COUNT(*) AS count FROM podcast_shows WHERE archived_at IS NULL')
      .get() as { count: number }).count;
    const episodes = (this.db.prepare('SELECT COUNT(*) AS count FROM podcast_episodes').get() as { count: number }).count;
    const partial = (this.db.prepare(`SELECT COUNT(*) AS count FROM podcast_shows
      WHERE archived_at IS NULL AND coverage_status IN ('partial', 'page_only')`).get() as { count: number }).count;
    const archived = (this.db.prepare('SELECT COUNT(*) AS count FROM podcast_shows WHERE archived_at IS NOT NULL')
      .get() as { count: number }).count;
    const lastRun = this.db.prepare('SELECT started_at FROM podcast_ingest_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { started_at: number } | undefined;
    return {
      shows, episodes, partial_shows: partial, archived_shows: archived,
      last_run_at: lastRun ? iso(lastRun.started_at) : null,
    };
  }
}
