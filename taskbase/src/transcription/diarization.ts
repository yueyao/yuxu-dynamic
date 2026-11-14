/** 整集说话者分析和词时间对齐；模型与 ASR 分开运行。 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from '../process.ts';
import type { AsrSegment } from './asr.ts';
import type { DiarizationMetadata, TranscriptSegment } from './contract.ts';

export const DIARIZATION_MODEL = 'pyannote/speaker-diarization-community-1';
export type SpeakerTurn = { start: number; end: number; speaker: string };
export type DiarizationResult = { turns: SpeakerTurn[]; metadata: DiarizationMetadata };
export type DiarizationProvider = {
  readonly cacheIdentity: string;
  prepare?(signal?: AbortSignal): Promise<void>;
  analyze(path: string, signal?: AbortSignal): Promise<DiarizationResult>;
};

export function normalizeTurns(value: unknown): SpeakerTurn[] {
  if (!Array.isArray(value) || !value.length) throw new Error('DIARIZATION_INVALID: 没有检测到说话者');
  const turns = value.map((item: SpeakerTurn) => {
    if (!item || !Number.isFinite(item.start) || item.start < 0 || !Number.isFinite(item.end)
      || item.end <= item.start || typeof item.speaker !== 'string' || !item.speaker.trim()) {
      throw new Error('DIARIZATION_INVALID: 说话者时间区间无效');
    }
    return { start: item.start, end: item.end, speaker: item.speaker };
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
  const ids = new Map<string, string>();
  const groups = new Map<string, SpeakerTurn[]>();
  for (const turn of turns) {
    if (!ids.has(turn.speaker)) ids.set(turn.speaker, `speaker_${ids.size + 1}`);
    const speaker = ids.get(turn.speaker)!;
    const list = groups.get(speaker) ?? [];
    const last = list.at(-1);
    if (last && turn.start <= last.end) last.end = Math.max(last.end, turn.end);
    else list.push({ ...turn, speaker });
    groups.set(speaker, list);
  }
  return [...groups.values()].flat().sort((a, b) => a.start - b.start || a.end - b.end);
}

export function alignSpeakers(segments: AsrSegment[], turns: SpeakerTurn[]): TranscriptSegment[] {
  const normalized = normalizeTurns(turns);
  const dominant = (start: number, end: number): string | undefined => {
    const scores = new Map<string, number>();
    for (const turn of normalized) {
      if (turn.start >= end) break;
      const overlap = Math.max(0, Math.min(end, turn.end) - Math.max(start, turn.start));
      if (overlap > 0) scores.set(turn.speaker, (scores.get(turn.speaker) ?? 0) + overlap);
    }
    const ranking = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const first = ranking[0];
    const length = end - start;
    return first && length > 0 && first[1] / length >= 0.5
      && (first[1] - (ranking[1]?.[1] ?? 0)) / length >= 0.2 ? first[0] : undefined;
  };
  const output: TranscriptSegment[] = [];
  for (const segment of segments) {
    const words = segment.words;
    const valid = words?.length && words.every((w, index) => Number.isFinite(w.start) && Number.isFinite(w.end)
      && w.start >= segment.start && w.end <= segment.end && w.end > w.start
      && (index === 0 || w.start >= words[index - 1]!.end) && typeof w.text === 'string')
      && words.map((w) => w.text).join('').trim() === segment.text.trim();
    if (!valid) {
      const speaker = dominant(segment.start, segment.end);
      output.push({ start: segment.start, end: segment.end, text: segment.text,
        ...(speaker ? { speaker_id: speaker } : {}) });
      continue;
    }
    const pieces: TranscriptSegment[] = [];
    for (const word of words!) {
      const speaker = dominant(word.start, word.end);
      const last = pieces.at(-1);
      if (last && last.speaker_id === speaker) { last.text += word.text; last.end = word.end; }
      else pieces.push({ start: word.start, end: word.end, text: word.text, ...(speaker ? { speaker_id: speaker } : {}) });
    }
    // 空白词不独立丢弃；模型偶尔产生的空白片段归入相邻文本。
    if (pieces.some((p) => !p.text.trim())) {
      const speaker = dominant(segment.start, segment.end);
      output.push({ start: segment.start, end: segment.end, text: segment.text, ...(speaker ? { speaker_id: speaker } : {}) });
    } else output.push(...pieces);
  }
  return output;
}

export type PyannoteOptions = { python?: string; model?: string; revision?: string; device?: string;
  numSpeakers?: number; offline?: boolean; timeoutMs?: number };
export class PyannoteProvider implements DiarizationProvider {
  cacheIdentity: string;
  private readonly options: Required<Omit<PyannoteOptions, 'numSpeakers'>> & { numSpeakers?: number };
  constructor(options: PyannoteOptions = {}) {
    const python = options.python ?? process.env.TRANSCRIPTION_DIARIZATION_PYTHON;
    if (!python || !isAbsolute(python)) throw new Error('DIARIZATION_CONFIG: 请设置 TRANSCRIPTION_DIARIZATION_PYTHON 为专用 Python 的绝对路径');
    const model = options.model ?? process.env.TRANSCRIPTION_DIARIZATION_MODEL ?? DIARIZATION_MODEL;
    if (model !== DIARIZATION_MODEL && !isAbsolute(model)) throw new Error('DIARIZATION_CONFIG: 仅支持本地 community-1 模型');
    const numSpeakers = options.numSpeakers ?? (process.env.TRANSCRIPTION_DIARIZATION_NUM_SPEAKERS
      ? Number(process.env.TRANSCRIPTION_DIARIZATION_NUM_SPEAKERS) : undefined);
    if (numSpeakers !== undefined && (!Number.isSafeInteger(numSpeakers) || numSpeakers < 1)) {
      throw new Error('DIARIZATION_CONFIG: 说话者人数必须为正整数');
    }
    const device = options.device ?? process.env.TRANSCRIPTION_DIARIZATION_DEVICE ?? 'cpu';
    if (!['cpu', 'mps', 'cuda'].includes(device)) throw new Error('DIARIZATION_CONFIG: 设备必须为 cpu/mps/cuda');
    this.options = { python, model, numSpeakers, device,
      revision: options.revision ?? process.env.TRANSCRIPTION_DIARIZATION_REVISION ?? 'main',
      offline: options.offline ?? process.env.TRANSCRIPTION_DIARIZATION_OFFLINE === '1',
      timeoutMs: options.timeoutMs ?? 6 * 60 * 60 * 1000 };
    this.cacheIdentity = createHash('sha256').update(JSON.stringify({ format: 1, ...this.options })).digest('hex');
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    const opts = this.options;
    const args = [fileURLToPath(new URL('../../scripts/diarize.py', import.meta.url)), '--resolve-only',
      '--model', opts.model, '--revision', opts.revision];
    if (opts.offline) args.push('--offline');
    const resolved = JSON.parse(await runProcess(opts.python, args, { signal, timeoutMs: opts.timeoutMs })) as {
      revision: string; packages: Record<string, string>;
    };
    if (typeof resolved.revision !== 'string' || !resolved.revision) throw new Error('DIARIZATION_INVALID: 无法确定模型revision');
    this.cacheIdentity = createHash('sha256').update(JSON.stringify({ format: 1, ...opts, revision: resolved.revision, packages: resolved.packages })).digest('hex');
    // 远端revision固定为刚解析的commit，避免分析时main发生变化。
    if (opts.model === DIARIZATION_MODEL) opts.revision = resolved.revision;
  }
  async analyze(path: string, signal?: AbortSignal): Promise<DiarizationResult> {
    const directory = await mkdtemp(join(tmpdir(), 'yuxun-diarization-'));
    const output = join(directory, 'result.json');
    const opts = this.options;
    try {
      const args = [fileURLToPath(new URL('../../scripts/diarize.py', import.meta.url)),
        '--input', path, '--output', output, '--model', opts.model, '--revision', opts.revision, '--device', opts.device];
      if (opts.offline) args.push('--offline');
      if (opts.numSpeakers) args.push('--num-speakers', String(opts.numSpeakers));
      await runProcess(opts.python, args, { signal, timeoutMs: opts.timeoutMs });
      if ((await stat(output)).size > 7 * 1024 * 1024) throw new Error('DIARIZATION_INVALID: 结果超过检查点限制');
      const parsed = JSON.parse(await readFile(output, 'utf8')) as DiarizationResult;
      return { turns: normalizeTurns(parsed.turns), metadata: parsed.metadata };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
