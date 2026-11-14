import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TranscriptionStore } from '../src/transcription/store.ts';

const original = { taskId: 'old', episodeId: 'episode', title: 'Old', language: 'zh',
  provider: 'whisper-cli', model: 'small', durationSeconds: 2, text: '你好 世界',
  segments: [{ start: 0, end: 2, text: '你好 世界' }], artifactId: 'old-artifact' };
const v2 = { ...original, taskId: 'new', version: 2 as const,
  diarization: { provider: 'pyannote', model: 'pyannote/speaker-diarization-community-1', revision: 'test' },
  segments: [{ start: 0, end: 1, text: '你好', speaker_id: 'speaker_1' },
    { start: 1, end: 2, text: ' 世界', speaker_id: 'speaker_2' }] };

test('旧schema迁移两次保留ID、原文和产物；新v2幂等并优先于更新的v1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'version-'));
  const path = join(dir, 'db.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE transcription_transcripts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, episode_id TEXT, show_id TEXT, title TEXT,
    language TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, duration_seconds REAL,
    text TEXT NOT NULL, segments_json TEXT NOT NULL, artifact_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO transcription_transcripts VALUES ('old-id','old','episode',NULL,'Old','zh',
      'whisper-cli','small',2,'你好 世界','[]','old-artifact',1000)`);
  db.close();
  let store = new TranscriptionStore(path);
  assert.equal(store.getByTask('old')?.version, 1);
  assert.equal(store.getByTask('old')?.transcript_id, 'old-id');
  assert.equal(store.getByTask('old')?.artifact_id, 'old-artifact');
  assert.equal(store.getByTask('old')?.text, original.text);
  const saved = store.save(v2);
  assert.equal(store.save(v2).transcript_id, saved.transcript_id);
  store.save({ ...original, taskId: 'later' });
  assert.equal(store.getByEpisode('episode')?.version, 2);
  assert.equal(store.getByEpisode('episode', 1)?.version, 1);
  assert.deepEqual(store.availableVersions('episode'), [1, 2]);
  assert.equal(store.listMetadataPage({ version: 2 }).total, 1);
  assert.equal(store.listPage({ version: 1 }).items.length, 2);
  assert.equal(store.count(), 3);
  store.close();
  store = new TranscriptionStore(path);
  try { assert.deepEqual(store.getById(saved.transcript_id)?.diarization, v2.diarization); }
  finally { store.close(); }
});

test('四个进程同时启动迁移仍保持旧稿完整', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'version-concurrent-'));
  const path = join(dir, 'db.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE transcription_transcripts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, episode_id TEXT, show_id TEXT, title TEXT,
    language TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, duration_seconds REAL,
    text TEXT NOT NULL, segments_json TEXT NOT NULL, artifact_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO transcription_transcripts VALUES ('old-id','old','episode',NULL,'Old','zh',
      'whisper-cli','small',2,'你好 世界','[]','old-artifact',1000)`);
  db.close();
  const module = fileURLToPath(new URL('../src/transcription/store.ts', import.meta.url));
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--input-type=module', '-e',
    `import { TranscriptionStore } from ${JSON.stringify(module)}; const s = new TranscriptionStore(process.argv[1]); if(s.getByTask('old').version !== 1) process.exit(2); s.close();`, path])));
  const store = new TranscriptionStore(path);
  try { assert.equal(store.getByTask('old')?.text, '你好 世界'); assert.equal(store.count(), 1); }
  finally { store.close(); }
});

test('v2拒绝无标签/元数据和非法时间，同task不允许变更版本', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'version-invalid-'));
  const store = new TranscriptionStore(join(dir, 'db.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  for (const bad of [{ ...v2, segments: original.segments }, { ...v2, diarization: null },
    { ...v2, segments: [{ start: 2, end: 1, text: '坏', speaker_id: 'speaker_1' }] },
    { ...v2, version: 3 }]) {
    assert.throws(() => store.save(bad as typeof v2), /TRANSCRIPT_INVALID/);
  }
  assert.equal(store.count(), 0);
  store.save(original);
  assert.throws(() => store.save({ ...v2, taskId: original.taskId }), /TRANSCRIPT_VERSION_CONFLICT/);
  assert.equal(store.getByTask(original.taskId)?.version, 1);
});
