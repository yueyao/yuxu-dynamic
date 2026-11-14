/** 本地转写 Provider：调用已安装的 OpenAI Whisper CLI，输出 JSON segments。 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptSegment } from './store.ts';
import { runProcess } from '../process.ts';

export type AsrWord = { start: number; end: number; text: string };
export type AsrSegment = TranscriptSegment & { words?: AsrWord[] };

export type AsrResult = {
  text: string;
  segments: AsrSegment[];
  language: string;
  durationSeconds: number;
  provider: string;
  model: string;
};

export type AsrProvider = {
  readonly name: string;
  readonly model: string;
  readonly cacheIdentity?: string;
  transcribe(filePath: string, language?: string, signal?: AbortSignal): Promise<AsrResult>;
};

export type WhisperCliOptions = {
  backend?: string;
  mlxPython?: string;
  command?: string;
  model?: string;
  device?: string;
  initialPrompt?: string;
  timeoutMs?: number;
  wordTimestamps?: boolean;
};

export class WhisperCliProvider implements AsrProvider {
  readonly name: string;
  readonly model: string;
  private readonly command: string;
  private readonly prefix: string[];
  private readonly device: string;
  private readonly initialPrompt: string;
  private readonly timeoutMs: number;
  private readonly wordTimestamps: boolean;
  readonly cacheIdentity: string;

  constructor(options: WhisperCliOptions = {}) {
    const backend = options.backend ?? process.env.TRANSCRIPTION_WHISPER_BACKEND ?? 'cli';
    if (!['cli', 'mlx'].includes(backend)) throw new Error('TRANSCRIPTION_CONFIG: TRANSCRIPTION_WHISPER_BACKEND必须为cli或mlx');
    const python = options.mlxPython ?? process.env.TRANSCRIPTION_MLX_PYTHON;
    if (backend === 'mlx' && (!python || !isAbsolute(python))) {
      throw new Error('TRANSCRIPTION_CONFIG: TRANSCRIPTION_MLX_PYTHON需要专用Python绝对路径');
    }
    this.name = backend === 'mlx' ? 'mlx-whisper' : 'whisper-cli';
    this.command = backend === 'mlx' ? python! : options.command ?? process.env.TRANSCRIPTION_WHISPER_BIN ?? 'whisper';
    this.prefix = backend === 'mlx' ? [fileURLToPath(new URL('../../scripts/mlx-whisper.py', import.meta.url))] : [];
    this.model = options.model ?? process.env.TRANSCRIPTION_WHISPER_MODEL ?? 'small';
    this.device = backend === 'mlx' ? 'mlx' : options.device ?? process.env.TRANSCRIPTION_WHISPER_DEVICE ?? 'cpu';
    this.initialPrompt = options.initialPrompt ?? process.env.TRANSCRIPTION_INITIAL_PROMPT
      ?? '以下是普通话，请使用简体中文转写。';
    this.timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000;
    this.wordTimestamps = options.wordTimestamps ?? false;
    this.cacheIdentity = JSON.stringify([2, backend, this.command, this.prefix, this.model, this.device, this.initialPrompt, this.wordTimestamps]);
  }

  async transcribe(filePath: string, language = 'zh', signal?: AbortSignal): Promise<AsrResult> {
    const outputDir = await mkdtemp(join(tmpdir(), 'taskbase-whisper-'));
    try {
      const args = [
        ...this.prefix,
        filePath,
        '--model', this.model,
        '--task', 'transcribe',
        '--output_format', 'json',
        '--output_dir', outputDir,
        '--fp16', 'False',
        '--verbose', 'False',
        '--device', this.device,
        '--initial_prompt', this.initialPrompt,
      ];
      if (language && language !== 'auto') args.push('--language', language);
      if (this.wordTimestamps) args.push('--word_timestamps', 'True');
      await runProcess(this.command, args, { timeoutMs: this.timeoutMs, signal });

      const files = await readdir(outputDir);
      const expected = `${basename(filePath, extname(filePath))}.json`;
      const jsonFile = files.includes(expected) ? expected : files.find((file) => file.endsWith('.json'));
      if (!jsonFile) throw new Error('Whisper 没有生成 JSON 结果');
      const parsed = JSON.parse(await readFile(join(outputDir, jsonFile), 'utf8')) as {
        text?: string;
        language?: string;
        segments?: Array<{ start?: number; end?: number; text?: string;
          words?: Array<{ start?: number; end?: number; word?: string }> }>;
      };
      const segments: AsrSegment[] = (parsed.segments ?? [])
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end)
          && segment.start! >= 0 && segment.end! > segment.start!)
        .map((segment) => ({
          start: Number(segment.start),
          end: Number(segment.end),
          text: String(segment.text ?? '').trim(),
          ...(this.wordTimestamps && Array.isArray(segment.words) ? { words: segment.words.map((word) => ({
            start: Number(word.start), end: Number(word.end), text: String(word.word ?? ''),
          })) } : {}),
        }))
        .filter((segment) => segment.text.length > 0);
      const text = (parsed.text ?? segments.map((segment) => segment.text).join('')).trim();
      if (!text) throw new Error('Whisper 转写结果为空');
      if (this.wordTimestamps && !segments.some((s) => s.words?.some((w) =>
        Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.text.trim()))) {
        throw new Error('ASR_WORD_TIMESTAMPS_REQUIRED: 未返回词时间戳，请升级兼容脚本或配置已验证的MLX后端');
      }
      const durationSeconds = segments.length > 0
        ? Math.max(...segments.map((segment) => segment.end))
        : 0;
      return {
        text,
        segments,
        language: parsed.language ?? language,
        durationSeconds,
        provider: this.name,
        model: this.model,
      };
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
