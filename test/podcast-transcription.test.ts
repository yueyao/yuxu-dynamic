/** 播客转写 Worker 的来源、媒体和任务闭环行为测试。 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { createApiServer } from '../apps/platform-api/src/server.ts';
import { normalizeAudio, probeAudio } from '../apps/podcast-tools/src/media/audio.ts';
import { SafeHttpClient } from '../apps/podcast-tools/src/media/safe-http.ts';
import { executePodcastLease, runPodcastTaskOnce } from '../apps/podcast-tools/src/main.ts';
import { resolveXiaoyuzhouEpisodeFromHtml } from '../apps/podcast-tools/src/sources/xiaoyuzhou.ts';
import { createElevenLabsProvider } from '../apps/podcast-tools/src/transcription/elevenlabs.ts';
import { createFunASRProvider, FunASRError } from '../apps/podcast-tools/src/transcription/funasr.ts';
import { createConfiguredTranscriptionProvider } from '../apps/podcast-tools/src/transcription/configured.ts';
import type { TranscriptionProvider } from '../apps/podcast-tools/src/transcription/provider.ts';
import { parseManifest } from '../packages/core/src/manifest.ts';
import { Store } from '../packages/core/src/store.ts';

test('公开小宇宙单集页面解析为可下载音频', async () => {
  const html = await readFile('test/fixtures/xiaoyuzhou-episode.html', 'utf8');
  const episode = resolveXiaoyuzhouEpisodeFromHtml(
    'https://www.xiaoyuzhoufm.com/episode/episode-id',
    html,
  );

  assert.deepEqual(episode, {
    platform: 'xiaoyuzhou',
    canonicalUrl: 'https://www.xiaoyuzhoufm.com/episode/episode-id',
    episodeId: 'episode-eid',
    title: '玉虚播客转写测试',
    mediaUrl: 'https://media.xyzcdn.net/example/episode.m4a',
    resolverVersion: 'xiaoyuzhou-html-v1',
  });
});

test('音频标准化为 16kHz 单声道 FLAC 并保留可探测时长', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-audio-'));
  const source = join(dir, 'source.wav');
  const normalized = join(dir, 'normalized.flac');
  await writeFile(source, wavSilence({ durationSeconds: 1, sampleRate: 8000, channels: 2 }));

  try {
    const sourceMetadata = await probeAudio(source);
    assert.equal(sourceMetadata.sampleRate, 8000);
    assert.equal(sourceMetadata.channels, 2);

    const normalizedMetadata = await normalizeAudio(source, normalized);
    assert.equal(normalizedMetadata.formatName.includes('flac'), true);
    assert.equal(normalizedMetadata.sampleRate, 16000);
    assert.equal(normalizedMetadata.channels, 1);
    assert.ok(normalizedMetadata.durationSeconds >= 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('媒体下载在发出请求前拒绝私网地址', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-safe-http-'));
  let requested = false;

  try {
    for (const resolved of [
      { address: '127.0.0.1', family: 4 as const },
      { address: '::ffff:7f00:1', family: 6 as const },
    ]) {
      const client = new SafeHttpClient({
        resolveHost: async () => [resolved],
        request: async () => {
          requested = true;
          throw new Error('不应发送请求');
        },
      });
      await assert.rejects(
        client.download('https://media.example.test/audio.m4a', join(dir, 'audio.m4a'), {
          maxBytes: 1024,
          timeoutMs: 1000,
        }),
        /MEDIA_UNSAFE_ADDRESS/,
      );
    }
    assert.equal(requested, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('媒体下载超过字节上限时不保留不完整文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-safe-http-limit-'));
  const destination = join(dir, 'audio.m4a');
  const client = new SafeHttpClient({
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'audio/mp4' },
      body: Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
    }),
  });

  try {
    await assert.rejects(client.download('https://media.example.test/audio.m4a', destination, {
      maxBytes: 10,
      timeoutMs: 1000,
    }), /MEDIA_TOO_LARGE/);
    await assert.rejects(access(destination), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('媒体下载在 Worker 中止时停止并清理不完整文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-safe-http-abort-'));
  const destination = join(dir, 'audio.m4a');
  const controller = new AbortController();
  const client = new SafeHttpClient({
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'audio/mp4' },
      body: Readable.from((async function* () {
        yield Buffer.alloc(8);
        await new Promise((done) => setTimeout(done, 50));
        yield Buffer.alloc(8);
      })()),
    }),
  });

  try {
    const download = client.download('https://media.example.test/audio.m4a', destination, {
      maxBytes: 1024,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new DOMException('测试中止', 'AbortError')), 5);
    await assert.rejects(download, { name: 'AbortError' });
    await assert.rejects(access(destination), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ElevenLabs Provider 发送音频并归一化词级时间戳', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-elevenlabs-'));
  const audioPath = join(dir, 'segment.flac');
  await writeFile(audioPath, Buffer.from('fake-flac'));
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'secret-key');
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get('model_id'), 'scribe_v2');
    assert.equal(init.body.get('language_code'), 'zh');
    assert.equal(init.body.get('diarize'), 'false');
    assert.equal(init.body.get('timestamps_granularity'), 'word');
    assert.ok(init.body.get('file') instanceof Blob);
    return Response.json({
      language_code: 'zh',
      language_probability: 0.99,
      text: '你好 世界',
      transcription_id: 'transcription-1',
      audio_duration_secs: 0.8,
      words: [
        { text: '你好', type: 'word', start: 0, end: 0.4, logprob: -0.1 },
        { text: ' ', type: 'spacing', start: 0.4, end: 0.4, logprob: 0 },
        { text: '世界', type: 'word', start: 0.4, end: 0.8, logprob: -0.2 },
      ],
    });
  };

  try {
    const provider = createElevenLabsProvider({ apiKey: 'secret-key', fetchImpl });
    const result = await provider.transcribe({
      audioPath,
      language: 'zh',
      timestamps: 'segment',
      diarization: false,
      requestKey: 'task:segment:0',
    });
    assert.equal(provider.name, 'elevenlabs');
    assert.equal(result.text, '你好 世界');
    assert.equal(result.language, 'zh');
    assert.equal(result.requestId, 'transcription-1');
    assert.deepEqual(result.segments, [{
      startMs: 0,
      endMs: 800,
      text: '你好 世界',
      words: [
        { startMs: 0, endMs: 400, text: '你好', confidence: -0.1 },
        { startMs: 400, endMs: 800, text: '世界', confidence: -0.2 },
      ],
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FunASR Provider 调用自托管服务并归一化分段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-funasr-'));
  const audioPath = join(dir, 'segment.flac');
  await writeFile(audioPath, Buffer.from('fake-flac'));
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8000/v1/audio/transcriptions');
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get('model'), 'sensevoice');
    assert.equal(init.body.get('language'), 'zh');
    assert.equal(init.body.get('response_format'), 'verbose_json');
    assert.equal(init.body.has('spk'), false);
    assert.ok(init.body.get('file') instanceof Blob);
    return Response.json({
      task: 'transcribe',
      language: 'zh',
      duration: 0.8,
      text: '你好世界',
      segments: [{
        id: 0,
        start: 0,
        end: 0.8,
        text: '你好世界',
        words: [
          { word: '你好', start: 0, end: 0.4 },
          { word: '世界', start: 0.4, end: 0.8 },
        ],
      }],
    });
  };

  try {
    const provider = createFunASRProvider({ fetchImpl });
    const result = await provider.transcribe({
      audioPath,
      language: 'zh',
      timestamps: 'segment',
      diarization: false,
      requestKey: 'task:segment:0',
    });
    assert.equal(provider.name, 'funasr');
    assert.equal(provider.model, 'sensevoice');
    assert.deepEqual(result, {
      text: '你好世界',
      language: 'zh',
      durationSeconds: 0.8,
      segments: [{
        startMs: 0,
        endMs: 800,
        text: '你好世界',
        words: [
          { startMs: 0, endMs: 400, text: '你好' },
          { startMs: 400, endMs: 800, text: '世界' },
        ],
      }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('自托管 FunASR 是默认 Provider，付费 Provider 需显式启用', () => {
  const local = createConfiguredTranscriptionProvider({});
  assert.equal(local.name, 'funasr');
  assert.equal(local.model, 'sensevoice@funasr-1.4.19-cpu');

  const paid = createConfiguredTranscriptionProvider({
    TRANSCRIPTION_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-key',
  });
  assert.equal(paid.name, 'elevenlabs');
  assert.equal(paid.model, 'scribe_v2');

  assert.throws(() => createConfiguredTranscriptionProvider({
    TRANSCRIPTION_PROVIDER: 'unknown',
  }), /TRANSCRIPTION_CONFIG_INVALID/);
});

test('播客 URL 任务由服务端 Worker 生成可下载文字稿', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-task-'));
  const store = new Store(join(dir, 'platform.sqlite'));
  const server = createApiServer(store, {
    artifactDir: join(dir, 'artifacts'),
    requestLog: () => {},
  });
  const fetchImpl = localFetch(server);
  const sourceAudio = join(dir, 'source.wav');
  await writeFile(sourceAudio, wavSilence({ durationSeconds: 1, sampleRate: 8000, channels: 2 }));
  const html = await readFile('test/fixtures/xiaoyuzhou-episode.html', 'utf8');
  const manifest = parseManifest(JSON.parse(
    await readFile('apps/podcast-tools/manifest.json', 'utf8'),
  ) as unknown);
  const provider: TranscriptionProvider = {
    name: 'fixture',
    model: 'fixture-v1',
    capabilities: { timestamps: ['segment'], diarization: false, languageDetection: true },
    async transcribe() {
      return {
        text: '这是服务端生成的测试文字稿。',
        language: 'zh',
        segments: [{ startMs: 0, endMs: 900, text: '这是服务端生成的测试文字稿。' }],
      };
    },
  };

  try {
    store.bootstrap('owner', 'a-long-test-password');
    const workerToken = store.registerApplication(manifest);
    const task = store.createTask('user:owner', 'podcast-tools', 'audio/transcribe', {
      source_url: 'https://www.xiaoyuzhoufm.com/episode/episode-id',
      language: 'auto',
      timestamps: 'segment',
      speaker_diarization: false,
      output_format: 'markdown',
      quality: 'balanced',
    }, null).task;

    const worked = await runPodcastTaskOnce({
      baseUrl: 'http://platform.local',
      token: workerToken,
      fetchImpl,
      workspaceRoot: join(dir, 'work'),
      provider,
      resolveEpisode: async (url) => resolveXiaoyuzhouEpisodeFromHtml(url, html),
      acquireAudio: async (_episode, destination) => {
        await copyFile(sourceAudio, destination);
        const bytes = await readFile(destination);
        return {
          finalUrl: 'https://media.xyzcdn.net/example/episode.m4a',
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          contentType: 'audio/wav',
        };
      },
    });

    assert.equal(worked, true);
    const completed = store.getTask(task.task_id);
    assert.equal(completed.status, 'succeeded');
    assert.ok(completed.artifact_id);
    assert.deepEqual(completed.output, {
      artifact_id: completed.artifact_id,
      source_platform: 'xiaoyuzhou',
      canonical_url: 'https://www.xiaoyuzhoufm.com/episode/episode-id',
      source_episode_id: 'episode-eid',
      title: '玉虚播客转写测试',
      language: 'zh',
      duration_seconds: 1,
      segment_count: 1,
      format: 'markdown',
      audio_sha256: createHash('sha256').update(await readFile(sourceAudio)).digest('hex'),
    });
    const artifact = await readFile(join(dir, 'artifacts', completed.artifact_id), 'utf8');
    assert.match(artifact, /# 玉虚播客转写测试/);
    assert.match(artifact, /\[00:00:00 - 00:00:00\]/);
    assert.match(artifact, /这是服务端生成的测试文字稿/);
    const stepKeys = store.getEvents(task.task_id)
      .filter((event) => event.type === 'step')
      .map((event) => (event.payload as { step_key: string }).step_key);
    assert.deepEqual(stepKeys, [
      'source-resolved', 'audio-acquired', 'audio-normalized', 'segments-planned',
      'segment-000001', 'transcript-merged',
    ]);

    const rejected = store.createTask('user:owner', 'podcast-tools', 'audio/transcribe', {
      source_url: 'https://www.xiaoyuzhoufm.com/episode/episode-id',
      speaker_diarization: true,
    }, null).task;
    await assert.rejects(runPodcastTaskOnce({
      baseUrl: 'http://platform.local', token: workerToken, fetchImpl,
      workspaceRoot: join(dir, 'work'), provider,
    }), /DIARIZATION_UNAVAILABLE/);
    assert.equal(store.getTask(rejected.task_id).status, 'failed');
    assert.match(store.getTask(rejected.task_id).error ?? '', /^DIARIZATION_UNAVAILABLE:/);

    assert.throws(() => store.createTask('user:owner', 'podcast-tools', 'audio/transcribe', {
      source_url: 'https://example.com/podcast/episode-id',
    }, null), /source_url/);
  } finally {
    server.emit('close');
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('新 Worker attempt 重建媒体文件并跳过已确认的转写片段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-recovery-'));
  const store = new Store(join(dir, 'platform.sqlite'));
  const server = createApiServer(store, {
    artifactDir: join(dir, 'artifacts'),
    leaseMs: 60_000,
    requestLog: () => {},
  });
  const fetchImpl = localFetch(server);
  const sourceAudio = join(dir, 'source.wav');
  await writeFile(sourceAudio, wavSilence({ durationSeconds: 1.5, sampleRate: 8000, channels: 2 }));
  const html = await readFile('test/fixtures/xiaoyuzhou-episode.html', 'utf8');
  const manifest = parseManifest(JSON.parse(
    await readFile('apps/podcast-tools/manifest.json', 'utf8'),
  ) as unknown);
  const transcribedFiles: string[] = [];
  let resolveCount = 0;
  let acquireCount = 0;
  const provider: TranscriptionProvider = {
    name: 'recoverable-fixture',
    model: 'fixture-v1',
    capabilities: { timestamps: ['segment'], diarization: false, languageDetection: true },
    async transcribe(input) {
      const file = input.audioPath.slice(input.audioPath.lastIndexOf('/') + 1);
      transcribedFiles.push(file);
      if (transcribedFiles.length === 2) {
        throw new FunASRError(503, 'TRANSCRIPTION_FAILED: 模拟自托管 Provider 暂时不可用');
      }
      return {
        text: `转写 ${file}`,
        language: 'zh',
        segments: [{ startMs: 0, endMs: 400, text: `转写 ${file}` }],
      };
    },
  };

  try {
    store.bootstrap('owner', 'a-long-test-password');
    const workerToken = store.registerApplication(manifest);
    const task = store.createTask('user:owner', 'podcast-tools', 'audio/transcribe', {
      source_url: 'https://www.xiaoyuzhoufm.com/episode/episode-id',
    }, null).task;
    const options = {
      baseUrl: 'http://platform.local', token: workerToken, fetchImpl,
      workspaceRoot: join(dir, 'work'), provider, heartbeatMs: 1_000, segmentSeconds: 1,
      resolveEpisode: async (url: string) => {
        resolveCount += 1;
        return resolveXiaoyuzhouEpisodeFromHtml(url, html);
      },
      acquireAudio: async (_episode: unknown, destination: string) => {
        acquireCount += 1;
        await copyFile(sourceAudio, destination);
        const bytes = await readFile(destination);
        return {
          finalUrl: 'https://media.xyzcdn.net/example/episode.m4a',
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          contentType: 'audio/wav',
        };
      },
    };

    await assert.rejects(runPodcastTaskOnce(options), /Provider 暂时不可用/);
    const interrupted = store.getTask(task.task_id);
    assert.equal(interrupted.status, 'running');
    const firstAttemptId = store.getEvents(task.task_id).find((event) =>
      event.type === 'status' && (event.payload as { status?: string }).status === 'running')?.attempt_id;
    assert.ok(firstAttemptId);
    await assert.rejects(access(join(dir, 'work', task.task_id, firstAttemptId)),
      { code: 'ENOENT' });

    store.recoverExpired(Date.now() + 60_001);
    assert.equal(store.getTask(task.task_id).status, 'recovering');
    const recoveredLease = store.lease('podcast-tools', 'transcribe-v1', 60_000);
    assert.ok(recoveredLease);
    assert.equal('mediaUrl' in (recoveredLease.steps['source-resolved'] as object), false);
    assert.equal('path' in (recoveredLease.steps['audio-acquired'] as object), false);
    assert.equal('path' in (recoveredLease.steps['audio-normalized'] as object), false);
    assert.equal('path' in (recoveredLease.steps['segments-planned'] as object[])[0], false);
    assert.deepEqual(Object.fromEntries(Object.entries(
      recoveredLease.steps['segment-000001'] as Record<string, unknown>,
    ).filter(([key]) => ['provider', 'model'].includes(key))), {
      provider: 'recoverable-fixture', model: 'fixture-v1',
    });

    await executePodcastLease(options, recoveredLease);
    const completed = store.getTask(task.task_id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.attempt_count, 2);
    assert.equal(resolveCount, 2);
    assert.equal(acquireCount, 2);
    assert.deepEqual(transcribedFiles, [
      'segment-000000.flac',
      'segment-000001.flac',
      'segment-000001.flac',
    ]);
  } finally {
    server.emit('close');
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function wavSilence(options: { durationSeconds: number; sampleRate: number; channels: number }): Buffer {
  const bytesPerSample = 2;
  const dataSize = options.durationSeconds * options.sampleRate * options.channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(options.channels, 22);
  buffer.writeUInt32LE(options.sampleRate, 24);
  buffer.writeUInt32LE(options.sampleRate * options.channels * bytesPerSample, 28);
  buffer.writeUInt16LE(options.channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

class LocalResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  headersSent = false;

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
    this.headersSent = true;
    return this;
  }

  end(data?: string | Buffer): void {
    if (data) this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    this.emit('finish');
  }

  destroy(): void { this.emit('finish'); }
}

function localFetch(server: ReturnType<typeof createApiServer>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? Buffer.from(init.body as string | Uint8Array) : Buffer.alloc(0);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (body.length > 0) headers['content-length'] = String(body.length);
    const request = new PassThrough();
    Object.assign(request, {
      url: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      headers,
      socket: { remoteAddress: 'in-process-test' },
    });
    const response = new LocalResponse();
    const finished = once(response, 'finish');
    request.end(body);
    server.emit('request', request as unknown as IncomingMessage, response as unknown as ServerResponse);
    await finished;
    return new Response(response.status === 204 ? null : Buffer.concat(response.chunks), {
      status: response.status,
      headers: response.headers,
    });
  };
}
