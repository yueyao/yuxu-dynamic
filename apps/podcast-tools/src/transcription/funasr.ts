import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  TranscriptionProviderError,
  type TranscriptSegment,
  type TranscriptWord,
  type TranscriptionProvider,
} from './provider.ts';

export type FunASRProviderOptions = {
  baseUrl?: string;
  model?: string;
  deploymentId?: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

type FunASRWord = {
  word?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
  probability?: unknown;
  speaker?: unknown;
};

type FunASRSegment = {
  start?: unknown;
  end?: unknown;
  text?: unknown;
  speaker?: unknown;
  words?: unknown;
};

/** 调用内网自托管 FunASR OpenAI-compatible 文件转写端点。 */
export function createFunASRProvider(options: FunASRProviderOptions = {}): TranscriptionProvider {
  const baseUrl = providerBaseUrl(options.baseUrl ?? 'http://127.0.0.1:8000');
  const requestModel = options.model?.trim() || 'sensevoice';
  const deploymentId = options.deploymentId?.trim();
  return {
    name: 'funasr',
    model: deploymentId ? `${requestModel}@${deploymentId}` : requestModel,
    capabilities: {
      timestamps: ['none', 'segment'],
      diarization: false,
      languageDetection: true,
    },
    async transcribe(input) {
      if (input.diarization) {
        throw new Error('DIARIZATION_UNAVAILABLE: FunASR V1 Provider 未启用说话人分离');
      }
      const audio = await readFile(input.audioPath);
      const form = new FormData();
      form.append('file', new Blob([audio], { type: contentType(input.audioPath) }),
        basename(input.audioPath));
      form.append('model', requestModel);
      form.append('response_format', 'verbose_json');
      if (input.language !== 'auto') form.append('language', input.language);

      const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 30 * 60 * 1000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(new URL('/v1/audio/transcriptions', baseUrl), {
          method: 'POST',
          headers: {
            ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
          },
          body: form,
          signal,
        });
      } catch (error) {
        throw new TypeError(`TRANSCRIPTION_FAILED: FunASR 请求失败：${errorMessage(error)}`);
      }

      const value = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        throw new FunASRError(response.status,
          `TRANSCRIPTION_FAILED: FunASR HTTP ${response.status}：${providerMessage(value)}`);
      }
      const root = record(value);
      if (!root || typeof root.text !== 'string') {
        throw new Error('TRANSCRIPTION_FAILED: FunASR 返回格式无效');
      }
      const durationSeconds = finiteNumber(root.duration);
      const segments = normalizeSegments(root.segments, root.text, durationSeconds);
      const responseLanguage = typeof root.language === 'string' ? root.language.trim() : '';
      const language = responseLanguage && responseLanguage !== 'unknown'
        ? responseLanguage
        : input.language === 'auto' ? 'und' : input.language;
      return {
        text: root.text,
        language,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        segments,
      };
    },
  };
}

export class FunASRError extends TranscriptionProviderError {
  constructor(status: number, message: string) {
    super('funasr', status, message);
  }
}

function providerBaseUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error('TRANSCRIPTION_CONFIG_INVALID: FUNASR_BASE_URL 不是有效 URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('TRANSCRIPTION_CONFIG_INVALID: FUNASR_BASE_URL 只允许不含凭据的 HTTP/HTTPS URL');
  }
  return url;
}

function normalizeSegments(value: unknown, text: string,
  durationSeconds: number | undefined): TranscriptSegment[] {
  const values = Array.isArray(value) ? value : [];
  const segments: TranscriptSegment[] = [];
  for (const raw of values) {
    const segment = record(raw) as FunASRSegment | undefined;
    const start = finiteNumber(segment?.start);
    const end = finiteNumber(segment?.end);
    if (!segment || start === undefined || end === undefined || end < start ||
      typeof segment.text !== 'string') continue;
    const words = normalizeWords(segment.words);
    segments.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: segment.text,
      ...(typeof segment.speaker === 'string' ? { speakerId: segment.speaker } : {}),
      ...(words.length > 0 ? { words } : {}),
    });
  }
  if (segments.length > 0 || !text.trim()) return segments;
  return [{ startMs: 0, endMs: Math.round((durationSeconds ?? 0) * 1000), text }];
}

function normalizeWords(value: unknown): TranscriptWord[] {
  if (!Array.isArray(value)) return [];
  const words: TranscriptWord[] = [];
  for (const raw of value) {
    const word = record(raw) as FunASRWord | undefined;
    const start = finiteNumber(word?.start);
    const end = finiteNumber(word?.end);
    const text = typeof word?.word === 'string' ? word.word :
      typeof word?.text === 'string' ? word.text : undefined;
    if (!word || start === undefined || end === undefined || end < start || !text) continue;
    words.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text,
      ...(typeof word.speaker === 'string' ? { speakerId: word.speaker } : {}),
      ...(typeof word.probability === 'number' ? { confidence: word.probability } : {}),
    });
  }
  return words;
}

function contentType(path: string): string {
  if (path.toLowerCase().endsWith('.flac')) return 'audio/flac';
  if (path.toLowerCase().endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

function providerMessage(value: unknown): string {
  const root = record(value);
  if (typeof root?.detail === 'string') return root.detail.slice(0, 500);
  if (typeof root?.message === 'string') return root.message.slice(0, 500);
  return '服务未返回可读错误';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知网络错误';
}
