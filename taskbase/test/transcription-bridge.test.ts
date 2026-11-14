import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PyannoteProvider } from '../src/transcription/diarization.ts';
import { runProcess } from '../src/process.ts';

test('Python桥接：解析revision固定检查点身份，读取文件结果，支持取消', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, 'fake-python.cjs');
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs'); const a=process.argv;
if(a.includes('--resolve-only')) console.log(JSON.stringify({revision:'fixed-sha',packages:{'pyannote.audio':'4.0.7'}}));
else fs.writeFileSync(a[a.indexOf('--output')+1], JSON.stringify({turns:[{start:0,end:1,speaker:'a'}], metadata:{provider:'pyannote',model:'test',revision:'fixed-sha'}}));
`);
  await chmod(command, 0o755);
  const provider = new PyannoteProvider({ python: command });
  await provider.prepare();
  const identity = provider.cacheIdentity;
  await provider.prepare();
  assert.equal(provider.cacheIdentity, identity);
  const result = await provider.analyze('fake.wav');
  assert.equal(result.turns[0]?.speaker, 'speaker_1');
  assert.equal(result.metadata.revision, 'fixed-sha');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(provider.analyze('fake.wav', cancelled.signal), { name: 'AbortError' });
});

for (const backend of ['cli', 'mlx']) test(`基准工具记录${backend}实际设备和三个阶段，不创建平台任务`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'benchmark-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const python = join(dir, 'python.cjs');
  const whisper = join(dir, 'whisper.cjs');
  const audio = join(dir, 'audio.wav');
  const output = join(dir, 'report.json');
  const generated = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', audio]);
  assert.equal(generated.status, 0);
  await writeFile(python, `#!/usr/bin/env node
const fs=require('node:fs'), a=process.argv;
if(a.includes('--resolve-only')) console.log(JSON.stringify({revision:'sha',packages:{}}));
else fs.writeFileSync(a[a.indexOf('--output')+1],JSON.stringify({turns:[{start:0,end:2,speaker:'a'}],metadata:{provider:'pyannote',model:'test'}}));`);
  await writeFile(whisper, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
if(a[0].endsWith('mlx-whisper.py')) a.shift();
fs.writeFileSync(path.join(a[a.indexOf('--output_dir')+1],path.basename(a[0],'.wav')+'.json'),JSON.stringify({text:'hello',language:'zh',segments:[{start:0,end:2,text:'hello',words:[{start:0,end:2,word:'hello'}]}]}));`);
  await chmod(python, 0o755); await chmod(whisper, 0o755);
  await runProcess(process.execPath, ['scripts/benchmark-transcription.ts', '--input', audio, '--output', output], {
    env: { ...process.env, TRANSCRIPTION_DIARIZATION_PYTHON: python, TRANSCRIPTION_WHISPER_BIN: whisper,
      TRANSCRIPTION_WHISPER_BACKEND: backend, TRANSCRIPTION_MLX_PYTHON: whisper,
      TRANSCRIPTION_WHISPER_DEVICE: 'cpu' }, timeoutMs: 20_000 });
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(report.v1_asr_seconds > 0);
  assert.ok(report.v2_asr_words_seconds > 0);
  assert.ok(report.diarization_seconds > 0);
  assert.equal(report.audio_seconds, 2);
  assert.equal(report.asr.provider, backend === 'mlx' ? 'mlx-whisper' : 'whisper-cli');
  assert.equal(report.asr.device, backend === 'mlx' ? 'mlx' : 'cpu');
  assert.match(await readFile(output + '.md', 'utf8'), /说话者 1/);
  if (process.platform === 'darwin') assert.match(await readFile(output + '.memory.txt', 'utf8'), /maximum resident set size/);
});
