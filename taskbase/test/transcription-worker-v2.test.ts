import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerClient, type WorkerLease } from '../src/worker-sdk.ts';
import { executeTranscriptionLease, mergeChunks } from '../src/transcription/worker.ts';
import type { AsrProvider } from '../src/transcription/asr.ts';
import type { DiarizationProvider } from '../src/transcription/diarization.ts';

test('v2合并将词时间偏移到整集', () => {
  const merged = mergeChunks([{ offset: 600, result: { text: 'a', language: 'zh', durationSeconds: 1,
    provider: 'test', model: 'test', segments: [{ start: 0, end: 1, text: 'a',
      words: [{ start: 0, end: 1, text: 'a' }] }] } }]);
  assert.equal(merged.segments[0]?.words?.[0]?.start, 600);
});

test('Worker默认v2：整集标签、分块恢复隔离、只上传一份带标签稿件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wav = join(dir, 'source.wav');
  const generated = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=4', '-ar', '16000', '-ac', '1', wav]);
  assert.equal(generated.status, 0);
  const audio = await readFile(wav);
  let asrCalls = 0;
  let diarizeCalls = 0;
  const provider: AsrProvider = { name: 'whisper-cli', model: 'tiny', cacheIdentity: 'fixture',
    async transcribe() { asrCalls++; return { text: '你好 世界', language: 'zh', durationSeconds: 2,
      provider: this.name, model: this.model, segments: [{ start: 0, end: 2, text: '你好 世界', words: [
        { start: 0, end: 1, text: '你好' }, { start: 1, end: 2, text: ' 世界' }] }] }; } };
  const diarizer: DiarizationProvider = { cacheIdentity: 'fixture', async analyze() {
    diarizeCalls++; return { turns: [{ start: 0, end: 1, speaker: 'a' }, { start: 1, end: 2, speaker: 'b' },
      { start: 2, end: 3, speaker: 'a' }, { start: 3, end: 5, speaker: 'b' }],
    metadata: { provider: 'pyannote', model: 'fixture', revision: 'fixed' } }; } };
  const outputs: any[] = [];
  const artifacts: string[] = [];
  const client = new WorkerClient({ baseUrl: 'http://fixture.invalid', token: 'fake', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/complete')) outputs.push(JSON.parse(String(init?.body)).output);
    if (path.endsWith('/artifacts')) { artifacts.push(Buffer.from(init!.body as Uint8Array).toString()); return Response.json({ artifact_id: 'artifact' }); }
    return Response.json({});
  } });
  const lease: WorkerLease = { task_id: 'task', attempt_id: 'attempt', app_id: 'transcription-tools',
    task_key: 'episode/transcribe', input: { audio_url: 'https://example.com/test.wav' },
    steps: { 'asr-chunk-0': { text: 'legacy checkpoint' } }, deadline_at: '', schedule_id: null, planned_fire_time: null };
  const options = { asrProvider: provider, diarizationProvider: diarizer, chunkSeconds: 2,
    downloadAudio: async (_url: string, path: string) => { await writeFile(path, audio); } };
  await executeTranscriptionLease(client, lease, options);
  assert.equal(outputs[0].version, 2);
  assert.ok(outputs[0].segments.some((s: any) => s.speaker_id === 'speaker_1'));
  assert.ok(outputs[0].segments.some((s: any) => s.speaker_id === 'speaker_2'));
  assert.equal(outputs[0].segments.some((s: any) => 'words' in s), false);
  assert.match(artifacts[0]!, /说话者 1/);
  assert.equal(artifacts.length, 1);
  const first = asrCalls;
  await executeTranscriptionLease(client, lease, options);
  assert.equal(asrCalls, first);
  assert.equal(diarizeCalls, 1);
  await executeTranscriptionLease(client, lease, { ...options, chunkSeconds: 4 });
  assert.ok(asrCalls > first);
  const completed = outputs.length;
  await assert.rejects(executeTranscriptionLease(client, { ...lease, steps: {} }, { ...options,
    diarizationProvider: { cacheIdentity: 'fail', analyze: async () => { throw new Error('model unavailable'); } } }), /model unavailable/);
  assert.equal(outputs.length, completed);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(executeTranscriptionLease(client, lease, { ...options, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(outputs.length, completed);
});
