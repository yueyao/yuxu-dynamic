#!/usr/bin/env node
/** 转写 Worker：下载公开音频 → ffmpeg 标准化 → 本地 ASR → 保存转写稿并上传远端产物。 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../config.ts';
import { RemoteError, WorkerClient, sleep, type WorkerLease } from '../worker-sdk.ts';
import { TRANSCRIPTION_APP_ID } from './manifest.ts';
import { TranscriptionStore, type TranscriptSegment } from './store.ts';
import { WhisperCliProvider, type AsrProvider } from './asr.ts';

const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

export type TranscriptionWorkerOptions = {
  dataDir?: string;
  asrProvider?: AsrProvider;
  fetchImpl?: typeof fetch;
  pollMs?: number;
};

type TaskInput = {
  audio_url: string;
  episode_id?: string;
  show_id?: string;
  title?: string;
  language?: string;
};

function input(value: unknown): TaskInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('转写任务输入必须是对象');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.audio_url !== 'string' || !record.audio_url.startsWith('http')) {
    throw new Error('缺少有效的 audio_url');
  }
  return {
    audio_url: record.audio_url,
    episode_id: typeof record.episode_id === 'string' ? record.episode_id : undefined,
    show_id: typeof record.show_id === 'string' ? record.show_id : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
    language: typeof record.language === 'string' ? record.language : undefined,
  };
}

async function download(url: string, destination: string, fetchImpl: typeof fetch): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('音频 URL 必须是 http(s)');
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'Mozilla/5.0 Taskbase/0.2' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`音频下载失败：HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) throw new Error('音频超过 500 MiB 限制');
  if (!response.body) throw new Error('音频响应为空');
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_AUDIO_BYTES) {
        controller.error(new Error('音频超过 500 MiB 限制'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body.pipeThrough(counter) as never), createWriteStream(destination, { mode: 0o600 }));
}

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', inputPath,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 失败（${code}）：${error.slice(-1000)}`));
    });
  });
}

function timestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600).toString().padStart(2, '0');
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function markdown(task: TaskInput, provider: AsrProvider, result: {
  text: string; segments: TranscriptSegment[]; language: string; durationSeconds: number;
}): string {
  const lines = [
    `# ${task.title ?? '转写稿'}`,
    '',
    `- 语言：${result.language}`,
    `- 时长：${timestamp(result.durationSeconds)}`,
    `- 引擎：${provider.name} / ${provider.model}`,
    '',
    '## 文字稿',
    '',
    result.text,
  ];
  if (result.segments.length > 0) {
    lines.push('', '## 时间戳', '');
    for (const segment of result.segments) {
      lines.push(`- [${timestamp(segment.start)} → ${timestamp(segment.end)}] ${segment.text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function executeTranscriptionLease(client: WorkerClient, lease: WorkerLease,
  store: TranscriptionStore, options: TranscriptionWorkerOptions = {}): Promise<void> {
  if (lease.app_id !== TRANSCRIPTION_APP_ID || lease.task_key !== 'episode/transcribe') {
    throw new Error('不是转写应用的任务');
  }
  const task = input(lease.input);
  const provider = options.asrProvider ?? new WhisperCliProvider();
  const fetchImpl = options.fetchImpl ?? fetch;
  const workDir = await mkdtemp(join(tmpdir(), 'taskbase-transcribe-'));
  try {
    await client.withHeartbeat(lease, async (active) => {
      await active.log(lease, 'info', `开始转写：${task.title ?? task.audio_url}`);
      await active.progress(lease, 5, '下载音频');
      const downloaded = join(workDir, 'source');
      await download(task.audio_url, downloaded, fetchImpl);

      await active.progress(lease, 20, '转换为 16k 单声道 WAV');
      const wav = join(workDir, 'audio.wav');
      await runFfmpeg(downloaded, wav);

      await active.progress(lease, 30, `本地 ASR（${provider.name}/${provider.model}）`);
      const result = await provider.transcribe(wav, task.language ?? 'zh');
      await active.progress(lease, 80, '生成文字稿');
      const artifact = Buffer.from(markdown(task, provider, result), 'utf8');
      const artifactId = await active.uploadArtifact(lease, 'transcript.md', artifact, 'text/markdown; charset=utf-8');
      const transcript = store.save({
        taskId: lease.task_id,
        episodeId: task.episode_id ?? null,
        showId: task.show_id ?? null,
        title: task.title ?? null,
        language: result.language,
        provider: result.provider,
        model: result.model,
        durationSeconds: result.durationSeconds,
        text: result.text,
        segments: result.segments,
        artifactId,
      });
      await active.progress(lease, 95, '上传完成');
      await active.complete(lease, {
        transcript_id: transcript.transcript_id,
        artifact_id: artifactId,
        segments: result.segments,
        language: result.language,
        duration_seconds: result.durationSeconds,
        text: result.text,
        provider: result.provider,
        model: result.model,
      });
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runTranscriptionOnce(client: WorkerClient, store: TranscriptionStore,
  options: TranscriptionWorkerOptions = {}): Promise<boolean> {
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executeTranscriptionLease(client, lease, store, options);
  } catch (error) {
    const stale = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    if (!stale) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      console.error('转写任务失败', message);
      await client.fail(lease, message).catch(() => {});
    }
  }
  return true;
}

async function main(): Promise<void> {
  const token = process.env.TASKBASE_WORKER_TOKEN;
  if (!token) throw new Error('请设置 TASKBASE_WORKER_TOKEN');
  const store = new TranscriptionStore(config.dbPath);
  const client = new WorkerClient({
    baseUrl: process.env.TASKBASE_URL ?? 'http://127.0.0.1:3333',
    token,
    heartbeatMs: Number(process.env.TASKBASE_HEARTBEAT_MS ?? 15_000),
  });
  const options: TranscriptionWorkerOptions = {
    dataDir: config.dataDir,
    pollMs: Number(process.env.TASKBASE_POLL_MS ?? 2_000),
  };
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  console.log('Transcription Worker 已启动');
  while (!controller.signal.aborted) {
    try {
      const worked = await runTranscriptionOnce(client, store, options);
      if (!worked) await sleep(options.pollMs ?? 2_000, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('Transcription Worker 循环出错', error);
      await sleep(3_000, controller.signal).catch(() => {});
    }
  }
  store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
