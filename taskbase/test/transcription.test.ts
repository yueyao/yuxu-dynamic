import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WhisperCliProvider } from '../src/transcription/asr.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';

test('转写表：按 task/episode 读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-transcript-'));
  const store = new TranscriptionStore(join(directory, 'taskbase.sqlite'));
  try {
    const saved = store.save({
      taskId: 'task-asr-1', episodeId: 'ep-1', showId: 'show-1', title: '测试单集',
      language: 'zh', provider: 'fake', model: 'tiny', durationSeconds: 8,
      text: '大家好，欢迎收听。', segments: [{ start: 0, end: 8, text: '大家好，欢迎收听。' }],
      artifactId: 'artifact-1',
    });
    assert.equal(saved.text, '大家好，欢迎收听。');
    assert.equal(store.getByTask('task-asr-1')?.artifact_id, 'artifact-1');
    assert.equal(store.getByEpisode('ep-1')?.transcript_id, saved.transcript_id);
    assert.equal(store.getByEpisode('missing'), null);
    const updated = store.save({
      taskId: 'task-asr-1', episodeId: 'ep-1', title: '测试单集', language: 'zh',
      provider: 'fake', model: 'tiny', durationSeconds: 8, text: '更新文本',
      segments: [{ start: 0, end: 8, text: '更新文本' }], artifactId: 'artifact-2',
    });
    assert.equal(updated.transcript_id, saved.transcript_id);
    assert.equal(updated.text, '更新文本');
    assert.equal(store.listPage({ query: '测试' }).items.length, 1);
    assert.equal(store.listPage({ query: '不存在' }).items.length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Whisper CLI Provider：调用命令并解析 JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbase-whisper-fixture-'));
  const script = join(directory, 'fake-whisper.cjs');
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const input = args[0];
let out = '';
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === '--output_dir') out = args[i + 1];
}
const base = path.basename(input, path.extname(input));
fs.writeFileSync(path.join(out, base + '.json'), JSON.stringify({
  text: '测试转写文本',
  language: 'zh',
  segments: [{ start: 0, end: 1.5, text: '测试转写文本' }]
}));
`);
  await chmod(script, 0o755);
  const input = join(directory, 'audio.wav');
  await writeFile(input, Buffer.from('fake'));
  try {
    const provider = new WhisperCliProvider({ command: script, model: 'tiny', timeoutMs: 5_000 });
    const result = await provider.transcribe(input, 'zh');
    assert.equal(result.text, '测试转写文本');
    assert.equal(result.language, 'zh');
    assert.equal(result.durationSeconds, 1.5);
    assert.equal(result.segments.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
