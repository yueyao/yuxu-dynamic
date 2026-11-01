import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  TranscriptionProviderError,
  type TranscriptSegment,
  type TranscriptWord,
  type TranscriptionProvider,
} from './provider.ts';

export type ElevenLabsProviderOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

type ElevenLabsWord = {
  text?: unknown;
  type?: unknown;
  start?: unknown;
  end?: unknown;
  logprob?: unknown;
  speaker_id?: unknown;
};

/** 官方同步 Batch STT API 适配器；密钥只通过 Worker 环境注入。 */
export function createElevenLabsProvider(options: ElevenLabsProviderOptions): TranscriptionProvider {
  if (!options.apiKey.trim()) throw new Error('TRANSCRIPTION_CONFIG_INVALID: 缺少 ELEVENLABS_API_KEY');
  const model = options.model ?? 'scribe_v2';
  return {
    name: 'elevenlabs',
    model,
    capabilities: {
      timestamps: ['segment', 'word'],
      diarization: true,
      languageDetection: true,
    },
    async transcribe(input) {
      const audio = await readFile(input.audioPath);
      const form = new FormData();
      form.append('file', new Blob([audio], { type: contentType(input.audioPath) }), basename(input.audioPath));
      form.append('model_id', model);
      form.append('diarize', String(input.diarization));
      form.append('tag_audio_events', 'false');
      form.append('timestamps_granularity', 'word');
      if (input.language !== 'auto') form.append('language_code', input.language);

      const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 30 * 60 * 1000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(new URL('/v1/speech-to-text',
          options.baseUrl ?? 'https://api.elevenlabs.io'), {
          method: 'POST',
          headers: {
            'xi-api-key': options.apiKey,
            'x-correlation-id': input.requestKey.slice(0, 100),
          },
          body: form,
          signal,
        });
      } catch (error) {
        throw new TypeError(`TRANSCRIPTION_FAILED: ElevenLabs 请求失败：${errorMessage(error)}`);
      }

      const value = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        throw new ElevenLabsError(response.status,
          `TRANSCRIPTION_FAILED: ElevenLabs HTTP ${response.status}：${providerMessage(value)}`);
      }
      const root = record(value);
      if (!root || typeof root.text !== 'string' || typeof root.language_code !== 'string' ||
        !Array.isArray(root.words)) {
        throw new Error('TRANSCRIPTION_FAILED: ElevenLabs 返回格式无效');
      }
      const words = normalizeWords(root.words as ElevenLabsWord[]);
      const startMs = words[0]?.startMs ?? 0;
      const endMs = words.at(-1)?.endMs ?? Math.round(number(root.audio_duration_secs) * 1000);
      const segment: TranscriptSegment = {
        startMs,
        endMs,
        text: root.text,
        ...(words.length > 0 ? { words } : {}),
      };
      return {
        text: root.text,
        language: root.language_code,
        durationSeconds: numberOrUndefined(root.audio_duration_secs),
        requestId: typeof root.transcription_id === 'string' ? root.transcription_id : undefined,
        segments: [segment],
      };
    },
  };
}

export class ElevenLabsError extends TranscriptionProviderError {
  constructor(status: number, message: string) {
    super('elevenlabs', status, message);
  }
}

function normalizeWords(values: ElevenLabsWord[]): TranscriptWord[] {
  const result: TranscriptWord[] = [];
  for (const value of values) {
    if (value.type !== 'word' || typeof value.text !== 'string' ||
      typeof value.start !== 'number' || typeof value.end !== 'number') continue;
    result.push({
      startMs: Math.round(value.start * 1000),
      endMs: Math.round(value.end * 1000),
      text: value.text,
      ...(typeof value.speaker_id === 'string' ? { speakerId: value.speaker_id } : {}),
      ...(typeof value.logprob === 'number' ? { confidence: value.logprob } : {}),
    });
  }
  return result;
}

function contentType(path: string): string {
  if (path.toLowerCase().endsWith('.flac')) return 'audio/flac';
  if (path.toLowerCase().endsWith('.wav')) return 'audio/wav';
  if (path.toLowerCase().endsWith('.m4a')) return 'audio/mp4';
  if (path.toLowerCase().endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

function providerMessage(value: unknown): string {
  const root = record(value);
  const detail = root?.detail;
  if (typeof detail === 'string') return detail.slice(0, 500);
  return '供应商未返回可读错误';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知网络错误';
}
