/** 转写 Provider 工厂：Whisper CLI、FunASR、ElevenLabs。 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { WhisperCliProvider, type AsrProvider, type AsrResult } from './asr.ts';
import type { TranscriptSegment } from './store.ts';
import { diagnosticMessage } from '../redact.ts';

export type ProviderEnvironment = Record<string, string | undefined>;

type FetchLike = typeof fetch;

export type FunAsrOptions = {
  baseUrl?: string;
  model?: string;
  apiToken?: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
};

export type ElevenLabsOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
  return diagnosticMessage(error);
}

function contentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeSegments(value: unknown, text: string, duration: number): TranscriptSegment[] {
  const rows = Array.isArray(value) ? value : [];
  const segments: TranscriptSegment[] = [];
  for (const row of rows) {
    const item = record(row);
    if (!item) continue;
    const start = finite(item.start) ?? (finite(item.start_ms) !== undefined ? finite(item.start_ms)! / 1000 : undefined);
    const end = finite(item.end) ?? (finite(item.end_ms) !== undefined ? finite(item.end_ms)! / 1000 : undefined);
    const content = typeof item.text === 'string' ? item.text.trim() : '';
    if (start === undefined || end === undefined || !content) continue;
    segments.push({ start: Math.max(0, start), end: Math.max(0, end), text: content });
  }
  if (segments.length === 0) {
    segments.push({ start: 0, end: Math.max(0, duration), text });
  }
  return segments;
}

function providerBaseUrl(input: string, label: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error(`TRANSCRIPTION_CONFIG_INVALID: ${label} 不是有效 URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`TRANSCRIPTION_CONFIG_INVALID: ${label} 只允许不含凭据的 HTTP/HTTPS URL`);
  }
  return url;
}

function statusError(provider: string, status: number, detail: string): Error {
  const transient = status === 408 || status === 429 || status >= 500;
  return new Error(`TRANSCRIPTION_FAILED: ${provider} HTTP ${status}${transient ? ' (transient)' : ''}: ${detail}`);
}

export class FunAsrProvider implements AsrProvider {
  readonly name = 'funasr';
  readonly model: string;
  private readonly url: URL;
  private readonly apiToken?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: FunAsrOptions = {}) {
    this.url = new URL('/v1/audio/transcriptions', providerBaseUrl(options.baseUrl
      ?? process.env.FUNASR_BASE_URL ?? 'http://127.0.0.1:8000', 'FUNASR_BASE_URL'));
    this.model = options.model ?? process.env.TRANSCRIPTION_MODEL ?? 'sensevoice';
    this.apiToken = options.apiToken ?? process.env.FUNASR_API_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30 * 60 * 1000;
  }

  async transcribe(filePath: string, language = 'zh', signal?: AbortSignal): Promise<AsrResult> {
    const audio = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType(filePath) }), basename(filePath));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    if (language !== 'auto') form.append('language', language);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {},
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`TRANSCRIPTION_FAILED: FunASR 请求失败：${errorMessage(error)}`);
    }
    const body = await response.json().catch(() => null) as unknown;
    const root = record(body);
    if (!response.ok) throw statusError('FunASR', response.status, diagnosticMessage(JSON.stringify(root ?? body), 500));
    if (!root || typeof root.text !== 'string') throw new Error('TRANSCRIPTION_FAILED: FunASR 返回格式无效');
    const duration = finite(root.duration) ?? 0;
    const segments = normalizeSegments(root.segments, root.text, duration);
    const detected = typeof root.language === 'string' && root.language !== 'unknown'
      ? root.language : language === 'auto' ? 'und' : language;
    return {
      text: root.text,
      segments,
      language: detected,
      durationSeconds: duration || Math.max(0, ...segments.map((segment) => segment.end)),
      provider: this.name,
      model: this.model,
    };
  }
}

export class ElevenLabsProvider implements AsrProvider {
  readonly name = 'elevenlabs';
  readonly model: string;
  private readonly url: URL;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsOptions) {
    if (!options.apiKey.trim()) throw new Error('TRANSCRIPTION_CONFIG_INVALID: 缺少 ELEVENLABS_API_KEY');
    this.url = new URL('/v1/speech-to-text', options.baseUrl ?? 'https://api.elevenlabs.io');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'scribe_v2';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30 * 60 * 1000;
  }

  async transcribe(filePath: string, language = 'zh', signal?: AbortSignal): Promise<AsrResult> {
    const audio = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType(filePath) }), basename(filePath));
    form.append('model_id', this.model);
    form.append('diarize', 'false');
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'word');
    if (language !== 'auto') form.append('language_code', language);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey },
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`TRANSCRIPTION_FAILED: ElevenLabs 请求失败：${errorMessage(error)}`);
    }
    const body = await response.json().catch(() => null) as unknown;
    const root = record(body);
    if (!response.ok) throw statusError('ElevenLabs', response.status, diagnosticMessage(JSON.stringify(root ?? body), 500));
    if (!root || typeof root.text !== 'string') throw new Error('TRANSCRIPTION_FAILED: ElevenLabs 返回格式无效');
    const words = Array.isArray(root.words) ? root.words.map(record) : [];
    const start = Math.min(...words.map((word) => finite(word?.start) ?? Infinity));
    const end = Math.max(...words.map((word) => finite(word?.end) ?? -Infinity));
    const duration = finite(root.audio_duration_secs)
      ?? (Number.isFinite(start) && Number.isFinite(end) ? end - start : 0);
    return {
      text: root.text,
      segments: [{ start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : duration, text: root.text }],
      language: typeof root.language_code === 'string' ? root.language_code : language === 'auto' ? 'und' : language,
      durationSeconds: duration,
      provider: this.name,
      model: this.model,
    };
  }
}

export function createAsrProvider(environment: ProviderEnvironment = process.env): AsrProvider {
  const name = (environment.TRANSCRIPTION_PROVIDER ?? 'whisper').trim().toLowerCase();
  if (name === 'whisper') {
    return new WhisperCliProvider({
      model: environment.TRANSCRIPTION_WHISPER_MODEL,
      device: environment.TRANSCRIPTION_WHISPER_DEVICE,
      command: environment.TRANSCRIPTION_WHISPER_BIN,
    });
  }
  if (name === 'funasr') {
    return new FunAsrProvider({
      baseUrl: environment.FUNASR_BASE_URL,
      model: environment.TRANSCRIPTION_MODEL,
      apiToken: environment.FUNASR_API_TOKEN,
    });
  }
  if (name === 'elevenlabs') {
    return new ElevenLabsProvider({
      apiKey: environment.ELEVENLABS_API_KEY ?? '',
      model: environment.TRANSCRIPTION_MODEL,
      baseUrl: environment.ELEVENLABS_BASE_URL,
    });
  }
  throw new Error(`TRANSCRIPTION_CONFIG_INVALID: 不支持的 TRANSCRIPTION_PROVIDER=${name}`);
}
