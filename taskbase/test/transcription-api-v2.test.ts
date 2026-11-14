import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlatformServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { PodcastStore } from '../src/podcast/store.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';
import { transcriptionManifest } from '../src/transcription/manifest.ts';
import { createWebServer } from '../web/server.ts';

test('API稿件版本：v1可升级、默认v2、筛选/下载/单集摘要一致', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'api-v2-'));
  const dbPath = join(dir, 'db.sqlite');
  const store = new Store(dbPath);
  store.bootstrap('owner', 'test-password-long');
  store.upsertApp(transcriptionManifest);
  const podcasts = new PodcastStore(dbPath);
  const transcripts = new TranscriptionStore(dbPath);
  const show = podcasts.addShow({ url: 'https://example.com/show', title: 'Show' });
  podcasts.upsertEpisodes(show.show_id, [{ sourceId: 'ep', title: 'Episode', description: null,
    publishedAt: null, durationSeconds: 2, audioUrl: 'https://example.com/a.mp3', imageUrl: null }]);
  const episode = podcasts.listEpisodes(show.show_id)[0]!;
  const base = { episodeId: episode.episode_id, showId: show.show_id, title: 'Episode', language: 'zh',
    provider: 'whisper-cli', model: 'small', durationSeconds: 2, text: '你好 世界', artifactId: null };
  const old = transcripts.save({ ...base, taskId: 'old', segments: [] });
  const platform = createPlatformServer(store, { artifactDir: join(dir, 'artifacts'), sweepMs: 1_000_000,
    schedulerMs: 1_000_000, requestLog: () => {} });
  await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
  const web = createWebServer({ platformUrl: `http://127.0.0.1:${(platform.address() as AddressInfo).port}`,
    dbPath, transcriptApiToken: 'test-token', requestLog: () => {} });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await new Promise<void>((resolve) => platform.close(() => resolve()));
    transcripts.close(); podcasts.close(); store.closeDb(); await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'test-password-long' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await login.json() as { csrf_token: string }).csrf_token;
  const read = async (path: string) => (await fetch(url + path, { headers: { cookie, authorization: 'Bearer test-token' } })).json() as Promise<any>;
  const add = await fetch(url + '/api/transcription/queue', { method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ episode_ids: [episode.episode_id] }) });
  assert.equal((await add.json() as any).added, 1);
  const current = transcripts.save({ ...base, taskId: 'new', version: 2,
    diarization: { provider: 'pyannote', model: 'test' }, segments: [
      { start: 0, end: 1, text: '你好', speaker_id: 'speaker_1' },
      { start: 1, end: 2, text: ' 世界', speaker_id: 'speaker_2' }] });
  const path = `/api/podcast/episodes/${episode.episode_id}/transcript`;
  const preferred = await read(path);
  assert.equal(preferred.transcript.version, 2);
  assert.deepEqual(preferred.available_versions, [1, 2]);
  assert.equal((await read(path + '?version=1')).transcript.transcript_id, old.transcript_id);
  assert.equal((await read('/api/v1/transcripts?version=2')).total, 1);
  assert.equal((await read('/api/transcription/transcripts?version=1')).total, 1);
  const lib = await read('/api/podcast/episodes');
  assert.equal(lib.summary.transcribed, 1);
  assert.equal(lib.episodes[0].transcript.version, 2);
  assert.equal(lib.episodes[0].transcript.transcript_id, current.transcript_id);
  for (const suffix of ['/api/v1/transcripts?version=3', path + '?version=01']) {
    assert.equal((await fetch(url + suffix, { headers: { cookie, authorization: 'Bearer test-token' } })).status, 400);
  }
  const markdown = await fetch(`${url}/api/v1/transcripts/${current.transcript_id}/markdown`, { headers: { authorization: 'Bearer test-token' } });
  assert.match(await markdown.text(), /版本：v2[\s\S]*说话者 1[\s\S]*说话者 2/);
});
