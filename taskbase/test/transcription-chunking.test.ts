import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mergeChunks, splitAudio } from '../src/transcription/worker.ts';

test('音频切片与合并保留 offset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-chunk-'));
  const wav = join(dir, 'audio.wav');
  try {
    const generated = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const chunks = await splitAudio(wav, dir, 5);
    assert.ok(chunks.length >= 3, `chunks=${chunks.length}`);
    assert.equal(chunks[0]?.offset, 0);
    assert.ok((chunks[1]?.offset ?? 0) >= 4.9);
    const merged = mergeChunks([
      { offset: 0, result: { text: '第一段', segments: [{ start: 0, end: 2, text: '第一段' }], language: 'zh', durationSeconds: 2, provider: 'fake', model: 'tiny' } },
      { offset: 10, result: { text: '第二段', segments: [{ start: 0, end: 1, text: '第二段' }], language: 'zh', durationSeconds: 1, provider: 'fake', model: 'tiny' } },
    ]);
    assert.equal(merged.text, '第一段\n第二段');
    assert.deepEqual(merged.segments[1], { start: 10, end: 11, text: '第二段' });
    assert.equal(merged.durationSeconds, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
