#!/usr/bin/env node
/** 转写 Worker：下载公开音频 → ffmpeg 标准化 → 本地 ASR → 交付结果与产物到服务端。 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envValue, positiveInt } from '../env.ts';
import { diagnosticMessage, redactText } from '../redact.ts';
import { RemoteError, WorkerClient, sleep, type WorkerLease } from '../worker-sdk.ts';
import { TRANSCRIPTION_APP_ID } from './manifest.ts';
import type { TranscriptSegment } from './store.ts';
import type { AsrProvider, AsrResult } from './asr.ts';
import { createAsrProvider } from './providers.ts';
import { SafeHttpClient } from './safe-http.ts';
import { renderTranscriptMarkdown } from './markdown.ts';
import { runProcess } from '../process.ts';

const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

export type TranscriptionWorkerOptions = {
  asrProvider?: AsrProvider;
  pollMs?: number;
  chunkSeconds?: number;
  signal?: AbortSignal;
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

async function download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
  const client = new SafeHttpClient({}, {
    allowInsecure: process.env.TRANSCRIPTION_ALLOW_INSECURE_HTTP === '1',
  });
  await client.download(url, destination, {
    maxBytes: MAX_AUDIO_BYTES,
    timeoutMs: 30 * 60 * 1000,
    signal,
    headers: { 'user-agent': 'Mozilla/5.0 Taskbase/0.3' },
  });
}

async function runFfmpeg(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  await runProcess('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', inputPath,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath,
  ], { signal });
}

async function probeDuration(path: string, signal?: AbortSignal): Promise<number> {
  const value = await runProcess('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ], { signal, timeoutMs: 60_000 });
  const duration = Number(value.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export type AudioChunk = { path: string; offset: number; duration: number };

/** 用 ffmpeg segment 切成独立 WAV；按实际时长累加 offset，避免依赖理论 chunk 边界。 */
export async function splitAudio(wav: string, workDir: string, chunkSeconds: number, signal?: AbortSignal): Promise<AudioChunk[]> {
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) throw new Error('chunkSeconds 必须是正数');
  const outputDir = join(workDir, 'chunks');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await runProcess('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', wav,
    '-f', 'segment', '-segment_time', String(chunkSeconds),
    '-reset_timestamps', '1', '-c', 'copy',
    join(outputDir, 'chunk-%05d.wav'),
  ], { signal });
  const files = (await readdir(outputDir))
    .filter((name) => name.endsWith('.wav'))
    .sort();
  if (files.length === 0) throw new Error('ffmpeg 没有生成音频切片');
  const chunks: AudioChunk[] = [];
  let offset = 0;
  for (const name of files) {
    const path = join(outputDir, name);
    const duration = await probeDuration(path, signal);
    chunks.push({ path, offset, duration });
    offset += duration;
  }
  return chunks;
}

export function mergeChunks(chunks: Array<{ offset: number; result: AsrResult }>): AsrResult {
  const segments: TranscriptSegment[] = [];
  const texts: string[] = [];
  let language = 'zh';
  let durationSeconds = 0;
  for (const { offset, result } of chunks) {
    if (result.text.trim()) texts.push(result.text.trim());
    language = result.language || language;
    for (const segment of result.segments) {
      segments.push({ start: segment.start + offset, end: segment.end + offset, text: segment.text });
    }
    durationSeconds += result.durationSeconds;
  }
  return {
    text: texts.join('\n'),
    segments,
    language,
    durationSeconds,
    provider: chunks[0]?.result.provider ?? 'unknown',
    model: chunks[0]?.result.model ?? 'unknown',
  };
}

export async function executeTranscriptionLease(client: WorkerClient, lease: WorkerLease,
  options: TranscriptionWorkerOptions = {}): Promise<void> {
  if (lease.app_id !== TRANSCRIPTION_APP_ID || lease.task_key !== 'episode/transcribe') {
    throw new Error('不是转写应用的任务');
  }
  const task = input(lease.input);
  const provider = options.asrProvider ?? createAsrProvider();
  const workDir = await mkdtemp(join(tmpdir(), 'taskbase-transcribe-'));
  try {
    await client.withHeartbeat(lease, async (active, signal) => {
      await active.log(lease, 'info', `开始转写：${task.title ?? lease.task_id}`);
      await active.progress(lease, 5, '下载音频');
      const downloaded = join(workDir, 'source');
      await download(task.audio_url, downloaded, signal);

      await active.progress(lease, 20, '转换为 16k 单声道 WAV');
      const wav = join(workDir, 'audio.wav');
      await runFfmpeg(downloaded, wav, signal);

      const chunkSeconds = options.chunkSeconds
        ?? Number(process.env.TRANSCRIPTION_CHUNK_SECONDS ?? 600);
      const chunks = await splitAudio(wav, workDir, chunkSeconds, signal);
      await active.progress(lease, 30, `音频 ${chunks.length} 段，开始转写`);
      const completed: Array<{ offset: number; result: AsrResult }> = [];
      for (const [index, chunk] of chunks.entries()) {
        signal.throwIfAborted();
        const stepKey = `asr-chunk-${index}`;
        let chunkResult = active.stepValue<AsrResult>(lease, stepKey);
        if (chunkResult) {
          await active.log(lease, 'info', `复用切片检查点 ${index + 1}/${chunks.length}`);
        } else {
          await active.progress(lease, 30 + Math.round((index / chunks.length) * 55),
            `转写切片 ${index + 1}/${chunks.length}`);
          chunkResult = await provider.transcribe(chunk.path, task.language ?? 'zh', signal);
          signal.throwIfAborted();
          await active.saveStep(lease, stepKey, chunkResult);
        }
        completed.push({ offset: chunk.offset, result: chunkResult });
      }
      const result = mergeChunks(completed);
      await active.progress(lease, 88, '生成文字稿');
      const artifact = Buffer.from(renderTranscriptMarkdown({
        title: task.title ?? null,
        language: result.language,
        provider: provider.name,
        model: provider.model,
        durationSeconds: result.durationSeconds,
        text: result.text,
        segments: result.segments,
      }), 'utf8');
      const artifactId = await active.uploadArtifact(lease, 'transcript.md', artifact, 'text/markdown; charset=utf-8');
      await active.progress(lease, 95, '上传完成');
      await active.complete(lease, {
        transcript_id: `transcript-${randomUUID()}`,
        artifact_id: artifactId,
        segments: result.segments,
        language: result.language,
        duration_seconds: result.durationSeconds,
        text: result.text,
        provider: result.provider,
        model: result.model,
      });
    }, options.signal);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runTranscriptionOnce(client: WorkerClient,
  options: TranscriptionWorkerOptions = {}): Promise<boolean> {
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executeTranscriptionLease(client, lease, options);
  } catch (error) {
    const stale = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    if (!stale) {
      const message = diagnosticMessage(error);
      console.error('转写任务失败', message);
      await client.fail(lease, message).catch(() => {});
    }
  }
  return true;
}

export type TranscriptionWorkerRunOptions = {
  token?: string;
  baseUrl?: string;
  heartbeatMs?: number;
  pollMs?: number;
};

export async function runTranscriptionWorker(overrides: TranscriptionWorkerRunOptions = {}): Promise<void> {
  const token = overrides.token
    ?? envValue('YUXUN_WORKER_TOKEN', 'TASKBASE_WORKER_TOKEN');
  if (!token) throw new Error('请设置 YUXUN_WORKER_TOKEN（兼容 TASKBASE_WORKER_TOKEN）');
  const baseUrl = overrides.baseUrl
    ?? envValue('YUXUN_URL', 'TASKBASE_URL', 'http://127.0.0.1:3333') as string;
  const client = new WorkerClient({
    baseUrl,
    token,
    heartbeatMs: positiveInt(overrides.heartbeatMs
      ?? envValue('YUXUN_HEARTBEAT_MS', 'TASKBASE_HEARTBEAT_MS'), 15_000, 'YUXUN_HEARTBEAT_MS'),
  });
  const options: TranscriptionWorkerOptions = {
    pollMs: positiveInt(overrides.pollMs
      ?? envValue('YUXUN_POLL_MS', 'TASKBASE_POLL_MS'), 2_000, 'YUXUN_POLL_MS'),
  };
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  console.log(`Transcription Worker 已启动：${redactText(baseUrl)}`);
  while (!controller.signal.aborted) {
    try {
      const worked = await runTranscriptionOnce(client, { ...options, signal: controller.signal });
      if (!worked) await sleep(options.pollMs ?? 2_000, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('Transcription Worker 循环出错', diagnosticMessage(error));
      await sleep(3_000, controller.signal).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runTranscriptionWorker().catch((error) => { console.error(diagnosticMessage(error)); process.exitCode = 1; });
}
