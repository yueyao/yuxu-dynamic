/** 本地转写 Provider：调用已安装的 OpenAI Whisper CLI，输出 JSON segments。 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { TranscriptSegment } from './store.ts';
import { runProcess } from '../process.ts';

export type AsrResult = {
  text: string;
  segments: TranscriptSegment[];
  language: string;
  durationSeconds: number;
  provider: string;
  model: string;
};

export type AsrProvider = {
  readonly name: string;
  readonly model: string;
  transcribe(filePath: string, language?: string, signal?: AbortSignal): Promise<AsrResult>;
};

export type WhisperCliOptions = {
  command?: string;
  model?: string;
  device?: string;
  initialPrompt?: string;
  timeoutMs?: number;
};

export class WhisperCliProvider implements AsrProvider {
  readonly name = 'whisper-cli';
  readonly model: string;
  private readonly command: string;
  private readonly device: string;
  private readonly initialPrompt: string;
  private readonly timeoutMs: number;

  constructor(options: WhisperCliOptions = {}) {
    this.command = options.command ?? process.env.TRANSCRIPTION_WHISPER_BIN ?? 'whisper';
    this.model = options.model ?? process.env.TRANSCRIPTION_WHISPER_MODEL ?? 'small';
    this.device = options.device ?? process.env.TRANSCRIPTION_WHISPER_DEVICE ?? 'cpu';
    this.initialPrompt = options.initialPrompt ?? process.env.TRANSCRIPTION_INITIAL_PROMPT
      ?? '以下是普通话，请使用简体中文转写。';
    this.timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000;
  }

  async transcribe(filePath: string, language = 'zh', signal?: AbortSignal): Promise<AsrResult> {
    const outputDir = await mkdtemp(join(tmpdir(), 'taskbase-whisper-'));
    try {
      const args = [
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
      await runProcess(this.command, args, { timeoutMs: this.timeoutMs, signal });

      const files = await readdir(outputDir);
      const expected = `${basename(filePath, extname(filePath))}.json`;
      const jsonFile = files.includes(expected) ? expected : files.find((file) => file.endsWith('.json'));
      if (!jsonFile) throw new Error('Whisper 没有生成 JSON 结果');
      const parsed = JSON.parse(await readFile(join(outputDir, jsonFile), 'utf8')) as {
        text?: string;
        language?: string;
        segments?: Array<{ start?: number; end?: number; text?: string }>;
      };
      const segments: TranscriptSegment[] = (parsed.segments ?? [])
        .filter((segment) => typeof segment.start === 'number' && typeof segment.end === 'number')
        .map((segment) => ({
          start: Number(segment.start),
          end: Number(segment.end),
          text: String(segment.text ?? '').trim(),
        }))
        .filter((segment) => segment.text.length > 0);
      const text = (parsed.text ?? segments.map((segment) => segment.text).join('')).trim();
      if (!text) throw new Error('Whisper 转写结果为空');
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
