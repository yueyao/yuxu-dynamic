/** 稿件版本与不可信任务结果的共同校验。历史无版本输出视为 v1。 */
export type TranscriptVersion = 1 | 2;
export type TranscriptSegment = { start: number; end: number; text: string; speaker_id?: string };
export type DiarizationMetadata = {
  provider: string;
  model: string;
  revision?: string;
  device?: string;
  packages?: Record<string, string>;
};

export class TranscriptContractError extends Error {
  constructor(message: string) { super(message); this.name = 'TranscriptContractError'; }
}

export function transcriptVersion(value: unknown): TranscriptVersion {
  if (value === undefined) return 1;
  if (value !== 1 && value !== 2) throw new TranscriptContractError('TRANSCRIPT_INVALID: 稿件版本必须为 1 或 2');
  return value;
}

export function validateTranscript(value: {
  version?: unknown; diarization?: unknown; segments: unknown; text: unknown;
}): TranscriptVersion {
  const version = transcriptVersion(value.version);
  if (version === 1) return version;
  const fail = () => { throw new TranscriptContractError('TRANSCRIPT_INVALID: v2 缺少有效说话者分析元数据、片段或标签'); };
  const meta = value.diarization as DiarizationMetadata | null;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || meta.provider !== 'pyannote' || typeof meta.model !== 'string' || !meta.model.trim()
    || Object.keys(meta).some((key) => !['provider', 'model', 'revision', 'device', 'packages'].includes(key))
    || [meta.revision, meta.device].some((item) => item !== undefined && (typeof item !== 'string' || !item.trim()))
    || (meta.packages !== undefined && (typeof meta.packages !== 'object' || meta.packages === null
      || Array.isArray(meta.packages) || Object.values(meta.packages).some((item) => typeof item !== 'string')))) fail();
  if (typeof value.text !== 'string' || !value.text.trim() || !Array.isArray(value.segments) || !value.segments.length) fail();
  let labeled = false;
  for (const segment of value.segments as TranscriptSegment[]) {
    if (!segment || typeof segment !== 'object' || !Number.isFinite(segment.start) || segment.start < 0
      || !Number.isFinite(segment.end) || segment.end <= segment.start
      || typeof segment.text !== 'string' || !segment.text.trim()
      || (segment.speaker_id !== undefined && (typeof segment.speaker_id !== 'string'
        || !/^speaker_[1-9]\d*$/.test(segment.speaker_id)))) fail();
    if (segment.speaker_id) labeled = true;
  }
  if (!labeled) fail();
  return version;
}

export function speakerLabel(id?: string): string {
  return id && /^speaker_[1-9]\d*$/.test(id) ? `说话者 ${id.slice(8)}` : '说话者未确定';
}
