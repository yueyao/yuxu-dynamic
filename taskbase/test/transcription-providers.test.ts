import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { FunAsrProvider, ElevenLabsProvider } from '../src/transcription/providers.ts';
import { SafeHttpClient } from '../src/transcription/safe-http.ts';

async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-provider-'));
  const file = join(dir, 'audio.wav');
  await writeFile(file, Buffer.from('RIFF'));
  return { dir, file };
}

test('FunASR Provider 解析 verbose_json', async () => {
  const { dir, file } = await fixture();
  try {
    const provider = new FunAsrProvider({
      baseUrl: 'http://asr.test', apiToken: 'token',
      fetchImpl: async (_url, init) => {
        assert.ok(init?.body instanceof FormData);
        return new Response(JSON.stringify({
          text: '你好世界', language: 'zh', duration: 2.5,
          segments: [{ start: 0, end: 1.2, text: '你好' }, { start: 1.2, end: 2.5, text: '世界' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const result = await provider.transcribe(file, 'zh');
    assert.equal(result.text, '你好世界');
    assert.equal(result.language, 'zh');
    assert.equal(result.segments.length, 2);
    assert.equal(result.durationSeconds, 2.5);
    assert.equal(result.provider, 'funasr');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ElevenLabs Provider 解析 word timestamps', async () => {
  const { dir, file } = await fixture();
  try {
    const provider = new ElevenLabsProvider({
      apiKey: 'key', fetchImpl: async () => new Response(JSON.stringify({
        text: '你好世界', language_code: 'zh', audio_duration_secs: 3,
        words: [{ text: '你好', start: 0, end: 1 }, { text: '世界', start: 1, end: 3 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const result = await provider.transcribe(file, 'zh');
    assert.equal(result.text, '你好世界');
    assert.equal(result.durationSeconds, 3);
    assert.equal(result.segments[0]?.start, 0);
    assert.equal(result.segments[0]?.end, 3);
    assert.equal(result.provider, 'elevenlabs');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SafeHttpClient 默认拒绝 HTTP，允许显式测试模式', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-safe-http-'));
  const target = join(dir, 'audio.bin');
  try {
    const defaultClient = new SafeHttpClient({
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => { throw new Error('should not request'); },
    });
    await assert.rejects(defaultClient.download('http://example.com/a.mp3', target, {
      maxBytes: 1024, timeoutMs: 1000,
    }), /HTTPS/);

    const testClient = new SafeHttpClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      request: async () => ({
        statusCode: 200,
        headers: { 'content-length': '3', 'content-type': 'audio/mpeg' },
        body: Readable.from([Buffer.from('abc')]),
      }),
    }, { allowInsecure: true });
    const result = await testClient.download('http://127.0.0.1/a.mp3', target, {
      maxBytes: 1024, timeoutMs: 1000,
    });
    assert.equal(result.byteSize, 3);
    assert.equal(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
