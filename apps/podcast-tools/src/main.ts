/** 服务端播客转写 Worker：客户端只提交公开播客页面 URL。 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerClient, RemoteError, isTransientWorkerError, sleep,
  type WorkerClientOptions, type WorkerLease } from '../../../packages/worker-sdk/src/index.ts';
import { validateJsonSchema } from '../../../packages/core/src/schema.ts';
import { parseManifest } from '../../../packages/core/src/manifest.ts';
import { normalizeAudio, segmentAudio, type AudioMetadata, type AudioSegment } from './media/audio.ts';
import { SafeHttpClient, type DownloadResult } from './media/safe-http.ts';
import { renderTranscriptMarkdown, renderTranscriptText } from './transcript/markdown.ts';
import { createElevenLabsProvider, ElevenLabsError } from './transcription/elevenlabs.ts';
import type { TranscriptSegment, TranscriptionProvider } from './transcription/provider.ts';
import { resolveXiaoyuzhouEpisodeFromHtml } from './sources/xiaoyuzhou.ts';
import type { PodcastTaskInput, ResolvedEpisode } from './types.ts';

const APP_ID = 'podcast-tools';
const TASK_KEY = 'audio/transcribe';
const RELEASE_DIGEST = 'transcribe-v1';
const MANIFEST = parseManifest({
  app_id: APP_ID,
  release_digest: RELEASE_DIGEST,
  max_concurrency: 1,
  tasks: [{
    task_key: TASK_KEY,
    timeout_ms: 21_600_000,
    max_attempts: 3,
    input_schema: {
      type: 'object', required: ['source_url'], additionalProperties: false,
      properties: {
        source_url: { type: 'string', minLength: 12, maxLength: 2048,
          pattern: '^https://www\\.xiaoyuzhoufm\\.com/episode/' },
        language: { type: 'string', enum: ['auto', 'zh', 'en'] },
        timestamps: { type: 'string', enum: ['none', 'segment'] },
        speaker_diarization: { type: 'boolean' },
        output_format: { type: 'string', enum: ['text', 'markdown'] },
        quality: { type: 'string', enum: ['fast', 'balanced', 'accurate'] },
      },
    },
    output_schema: {
      type: 'object', required: ['artifact_id', 'source_platform', 'canonical_url', 'title',
        'language', 'duration_seconds', 'segment_count', 'format', 'audio_sha256'],
      additionalProperties: false,
      properties: {
        artifact_id: { type: 'string', minLength: 1 }, source_platform: { type: 'string', minLength: 1 },
        canonical_url: { type: 'string', minLength: 1 }, source_episode_id: { type: 'string' },
        title: { type: 'string', minLength: 1 }, language: { type: 'string', minLength: 2 },
        duration_seconds: { type: 'number', minimum: 0 }, segment_count: { type: 'integer', minimum: 1 },
        format: { type: 'string', enum: ['text', 'markdown'] }, audio_sha256: { type: 'string', minLength: 64, maxLength: 64 },
      },
    },
  }],
});

export type PodcastWorkerOptions = WorkerClientOptions & {
  workspaceRoot?: string;
  provider?: TranscriptionProvider;
  httpClient?: Pick<SafeHttpClient, 'getText' | 'download'>;
  resolveEpisode?: (url: string) => Promise<ResolvedEpisode>;
  acquireAudio?: (episode: ResolvedEpisode, destination: string) => Promise<DownloadResult>;
  segmentSeconds?: number;
};

type SourceCheckpoint = Omit<ResolvedEpisode, 'mediaUrl'>;
type AcquiredCheckpoint = Pick<DownloadResult, 'byteSize' | 'sha256' | 'contentType' | 'etag' | 'lastModified'>;
type NormalizedCheckpoint = Pick<AudioMetadata, 'formatName' | 'codecName' | 'durationSeconds' | 'sampleRate' | 'channels'>;
type SegmentCheckpoint = Omit<AudioSegment, 'path'>;
type TranscriptCheckpoint = {
  provider: string;
  model: string;
  requestId?: string;
  text: string;
  language: string;
  segments: TranscriptSegment[];
};
type MergedCheckpoint = { language: string; segmentCount: number; text: string };

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export async function runPodcastTaskOnce(options: PodcastWorkerOptions): Promise<boolean> {
  const client = new WorkerClient(options);
  const lease = await client.lease();
  if (!lease) return false;
  try {
    await executePodcastLease(options, lease);
  } catch (error) {
    const stale = error instanceof RemoteError && error.code === 'STALE_ATTEMPT';
    if (!stale && !isTransientPodcastError(error) && !options.signal?.aborted) {
      await client.fail(lease, errorMessage(error).slice(0, 1000)).catch(() => {});
    }
    if (!stale) throw error;
  }
  return true;
}

export async function executePodcastLease(options: PodcastWorkerOptions, lease: WorkerLease): Promise<void> {
  if (lease.app_id !== APP_ID || lease.task_key !== TASK_KEY || lease.release_digest !== RELEASE_DIGEST) {
    throw new Error('PODCAST_TASK_UNSUPPORTED: Worker 不支持该任务版本');
  }
  const issues = validateJsonSchema(MANIFEST.tasks[0].input_schema, lease.input);
  if (issues.length > 0) throw new Error(`INVALID_INPUT: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`);
  const input = withDefaults(lease.input as PodcastTaskInput);
  if (input.speaker_diarization) throw new Error('DIARIZATION_UNAVAILABLE: V1 暂不支持跨片段一致的说话人分离');

  const workDir = join(resolve(options.workspaceRoot ?? '.local/podcast-work'), lease.task_id, lease.attempt_id);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const http = options.httpClient ?? new SafeHttpClient();
  const provider = options.provider ?? createElevenLabsProvider({
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    model: process.env.TRANSCRIPTION_MODEL,
  });
  try {
    await new WorkerClient(options).withHeartbeat(lease, async (client, signal) => {
      const source = await resolveSource(client, lease, input.source_url, options.resolveEpisode ??
        ((url) => resolveWithHttp(http, url, signal)));
      await client.progress(lease, 5, '播客页面解析完成');

      const acquired = await acquireSourceAudio(client, lease, source, workDir, options.acquireAudio ??
        ((episode, destination) => http.download(episode.mediaUrl, destination, {
          maxBytes: positiveConfiguration('PODCAST_MAX_AUDIO_BYTES', 2 * 1024 * 1024 * 1024),
          timeoutMs: positiveConfiguration('PODCAST_DOWNLOAD_TIMEOUT_MS', 30 * 60 * 1000),
          signal,
        })));
      await client.log(lease, 'info', `音频下载完成：${acquired.byteSize} 字节`);
      await client.progress(lease, 15, '音频下载并校验完成');

      const normalizedPath = join(workDir, 'normalized.flac');
      const metadata = await normalizeAudio(acquired.path, normalizedPath, { signal });
      const normalizedCheckpoint = toNormalizedCheckpoint(metadata);
      const savedNormalized = client.stepValue<NormalizedCheckpoint>(lease, 'audio-normalized');
      if (savedNormalized) assertNormalizedUnchanged(savedNormalized, normalizedCheckpoint);
      else await client.saveStep(lease, 'audio-normalized', normalizedCheckpoint);
      const maxDurationSeconds = positiveConfiguration('PODCAST_MAX_DURATION_SECONDS', 6 * 60 * 60);
      if (metadata.durationSeconds > maxDurationSeconds) {
        throw new Error(`MEDIA_TOO_LARGE: 音频时长超过 ${maxDurationSeconds} 秒限制`);
      }
      await client.log(lease, 'info', `音频标准化完成：${metadata.durationSeconds.toFixed(3)} 秒`);
      await client.progress(lease, 20, '音频标准化完成');

      // 片段文件只存在当前 attempt 工作目录；恢复时重建文件，但复用已确认的转写检查点。
      const segmentSeconds = options.segmentSeconds ?? positiveConfiguration('PODCAST_SEGMENT_SECONDS', 300);
      const segments = await planSegments(normalizedPath, workDir, segmentSeconds, signal);
      const currentPlan = segments.map(toSegmentCheckpoint);
      const savedPlan = client.stepValue<SegmentCheckpoint[]>(lease, 'segments-planned');
      if (savedPlan) assertSegmentPlanUnchanged(savedPlan, currentPlan);
      else await client.saveStep(lease, 'segments-planned', currentPlan);
      await client.log(lease, 'info', `音频切分为 ${segments.length} 个片段`);

      const transcripts: TranscriptSegment[] = [];
      let detectedLanguage: string | undefined;
      for (const segment of segments) {
        const key = `segment-${String(segment.index + 1).padStart(6, '0')}`;
        const saved = client.stepValue<TranscriptCheckpoint>(lease, key);
        if (saved) {
          if (saved.provider !== provider.name || saved.model !== provider.model) {
            throw new Error('TRANSCRIPTION_CONFIG_CHANGED: 恢复时 Provider 或模型版本已改变');
          }
          detectedLanguage ??= saved.language;
          transcripts.push(...saved.segments);
          continue;
        }
        const segmentResult = await provider.transcribe({
          audioPath: segment.path, language: input.language, timestamps: input.timestamps,
          diarization: false, requestKey: `${lease.task_id}:${key}:${lease.release_digest}`, signal,
        });
        const offsetSegments = segmentResult.segments.map((item) => ({
          ...item, startMs: item.startMs + segment.startMs, endMs: item.endMs + segment.startMs,
          ...(item.words ? { words: item.words.map((word) => ({
            ...word, startMs: word.startMs + segment.startMs, endMs: word.endMs + segment.startMs,
          })) } : {}),
        }));
        await client.saveStep(lease, key, {
          provider: provider.name, model: provider.model,
          ...(segmentResult.requestId ? { requestId: segmentResult.requestId } : {}),
          text: segmentResult.text, language: segmentResult.language, segments: offsetSegments,
        } satisfies TranscriptCheckpoint);
        detectedLanguage ??= segmentResult.language;
        transcripts.push(...offsetSegments);
        const completedDuration = segments.slice(0, segment.index + 1)
          .reduce((sum, item) => sum + item.durationSeconds, 0);
        await client.progress(lease, Math.min(90,
          20 + Math.round(completedDuration / metadata.durationSeconds * 70)),
        `已完成 ${segment.index + 1}/${segments.length} 个音频片段`);
      }

      const merged = dedupeSegments(transcripts);
      if (merged.length === 0) throw new Error('TRANSCRIPTION_FAILED: 转写引擎未返回文字片段');
      const savedMerged = client.stepValue<MergedCheckpoint>(lease, 'transcript-merged');
      const language = savedMerged?.language ??
        (input.language === 'auto' ? detectedLanguage ?? 'und' : input.language);
      if (!savedMerged) {
        await client.saveStep(lease, 'transcript-merged', {
          language, segmentCount: merged.length, text: merged.map((item) => item.text).join('\n'),
        } satisfies MergedCheckpoint);
      }
      const content = input.output_format === 'text'
        ? renderTranscriptText(merged)
        : renderTranscriptMarkdown({
          episode: source, language, durationSeconds: metadata.durationSeconds, segments: merged,
          timestamps: input.timestamps,
        });
      if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) {
        throw new Error('OUTPUT_TOO_LARGE: 文字稿超过当前 5 MiB 产物限制');
      }
      await client.progress(lease, 95, '文字稿已合并');
      const extension = input.output_format === 'text' ? 'txt' : 'md';
      const artifactId = await client.uploadTextArtifact(lease, artifactName(source, extension), content);
      await client.completeWithOutput(lease, {
        artifact_id: artifactId, source_platform: source.platform, canonical_url: source.canonicalUrl,
        source_episode_id: source.episodeId, title: source.title, language,
        duration_seconds: metadata.durationSeconds, segment_count: merged.length,
        format: input.output_format, audio_sha256: acquired.sha256,
      });
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveSource(client: WorkerClient, lease: WorkerLease, url: string,
  resolver: (url: string) => Promise<ResolvedEpisode>): Promise<ResolvedEpisode> {
  const source = await resolver(url);
  const { mediaUrl: _mediaUrl, ...checkpoint } = source;
  const existing = client.stepValue<SourceCheckpoint>(lease, 'source-resolved');
  if (existing) assertSourceUnchanged(existing, checkpoint);
  else await client.saveStep(lease, 'source-resolved', checkpoint);
  await client.log(lease, 'info', `已识别来源平台：${source.platform}`);
  return existing ? { ...existing, mediaUrl: source.mediaUrl } : source;
}

async function resolveWithHttp(http: Pick<SafeHttpClient, 'getText'>, url: string,
  signal?: AbortSignal): Promise<ResolvedEpisode> {
  const page = await http.getText(url, {
    maxBytes: positiveConfiguration('PODCAST_MAX_PAGE_BYTES', 5 * 1024 * 1024),
    timeoutMs: positiveConfiguration('PODCAST_PAGE_TIMEOUT_MS', 30_000),
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'yuxu-podcast-worker/1.0' },
    allowedHosts: ['www.xiaoyuzhoufm.com'],
    signal,
  });
  return resolveXiaoyuzhouEpisodeFromHtml(page.finalUrl, page.text);
}

async function acquireSourceAudio(client: WorkerClient, lease: WorkerLease, source: ResolvedEpisode,
  workDir: string, acquire: (source: ResolvedEpisode, destination: string) => Promise<DownloadResult>): Promise<DownloadResult & { path: string }> {
  const path = join(workDir, 'source.audio');
  const result = await acquire(source, path);
  const checkpoint = toAcquiredCheckpoint(result);
  const existing = client.stepValue<AcquiredCheckpoint>(lease, 'audio-acquired');
  if (existing) assertAudioUnchanged(existing, checkpoint);
  else await client.saveStep(lease, 'audio-acquired', checkpoint);
  return { ...result, path };
}

async function planSegments(path: string, workDir: string, seconds: number, signal?: AbortSignal): Promise<AudioSegment[]> {
  return segmentAudio(path, join(workDir, 'segments'), seconds, { signal });
}

function withDefaults(input: PodcastTaskInput): Required<PodcastTaskInput> {
  return {
    source_url: input.source_url, language: input.language ?? 'auto', timestamps: input.timestamps ?? 'segment',
    speaker_diarization: input.speaker_diarization ?? false, output_format: input.output_format ?? 'markdown',
    quality: input.quality ?? 'balanced',
  };
}

function dedupeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  return sorted.filter((segment, index) => index === 0 ||
    !(segment.text.trim() === sorted[index - 1].text.trim() && segment.startMs <= sorted[index - 1].endMs));
}

function artifactName(source: ResolvedEpisode, extension: 'txt' | 'md'): string {
  const identifier = safeName(source.episodeId ?? '') ||
    createHash('sha256').update(source.canonicalUrl).digest('hex').slice(0, 16);
  return `transcript-${identifier}.${extension}`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '播客任务失败'; }

function isTransientPodcastError(error: unknown): boolean {
  return isTransientWorkerError(error) ||
    (error instanceof ElevenLabsError && (error.status === 429 || error.status >= 500));
}

function positiveConfiguration(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`TRANSCRIPTION_CONFIG_INVALID: ${name} 必须是正数`);
  }
  return value;
}

function toAcquiredCheckpoint(result: DownloadResult): AcquiredCheckpoint {
  return {
    byteSize: result.byteSize,
    sha256: result.sha256,
    ...(result.contentType ? { contentType: result.contentType } : {}),
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
  };
}

function toNormalizedCheckpoint(metadata: AudioMetadata): NormalizedCheckpoint {
  return {
    formatName: metadata.formatName,
    codecName: metadata.codecName,
    durationSeconds: metadata.durationSeconds,
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
  };
}

function toSegmentCheckpoint(segment: AudioSegment): SegmentCheckpoint {
  const { path: _path, ...checkpoint } = segment;
  return checkpoint;
}

function assertSourceUnchanged(existing: SourceCheckpoint, current: SourceCheckpoint): void {
  if (existing.platform !== current.platform || existing.canonicalUrl !== current.canonicalUrl ||
    existing.episodeId !== current.episodeId || existing.resolverVersion !== current.resolverVersion) {
    throw new Error('SOURCE_CHANGED: 恢复时播客页面指向了不同的单集');
  }
}

function assertAudioUnchanged(existing: AcquiredCheckpoint, current: AcquiredCheckpoint): void {
  if (existing.sha256 !== current.sha256 || existing.byteSize !== current.byteSize) {
    throw new Error('SOURCE_CHANGED: 恢复时下载的音频内容已变化');
  }
}

function assertNormalizedUnchanged(existing: NormalizedCheckpoint, current: NormalizedCheckpoint): void {
  if (existing.sampleRate !== current.sampleRate || existing.channels !== current.channels ||
    Math.abs(existing.durationSeconds - current.durationSeconds) > 0.001) {
    throw new Error('SOURCE_CHANGED: 恢复时音频标准化结果已变化');
  }
}

function assertSegmentPlanUnchanged(existing: SegmentCheckpoint[], current: SegmentCheckpoint[]): void {
  if (existing.length !== current.length || existing.some((segment, index) => {
    const next = current[index];
    return !next || segment.index !== next.index || segment.startMs !== next.startMs ||
      segment.endMs !== next.endMs || Math.abs(segment.durationSeconds - next.durationSeconds) > 0.001;
  })) {
    throw new Error('SOURCE_CHANGED: 恢复时音频切片计划已变化');
  }
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
  const token = process.env.PODCAST_WORKER_TOKEN ??
    (await readFile(resolve(dataDir, `worker-token-${APP_ID}`), 'utf8')).trim();
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  const options: PodcastWorkerOptions = {
    baseUrl: process.env.PLATFORM_URL ?? 'http://127.0.0.1:3333', token, signal: controller.signal,
    workspaceRoot: process.env.PODCAST_WORK_DIR ?? resolve(dataDir, 'podcast-work'),
    heartbeatMs: Number(process.env.WORKER_HEARTBEAT_MS ?? 15_000),
  };
  console.log('播客转写 Worker 已启动');
  while (!controller.signal.aborted) {
    try {
      const worked = await runPodcastTaskOnce(options);
      if (!worked) await sleep(Number(process.env.WORKER_POLL_MS ?? 2_000), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('播客转写 Worker 出错', error);
      await sleep(2_000, controller.signal).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
