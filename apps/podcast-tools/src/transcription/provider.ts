export type TimestampGranularity = 'none' | 'segment' | 'word';

export type TranscriptWord = {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  confidence?: number;
};

export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  words?: TranscriptWord[];
};

export type TranscriptResult = {
  text: string;
  language: string;
  durationSeconds?: number;
  requestId?: string;
  segments: TranscriptSegment[];
};

export type TranscriptionInput = {
  audioPath: string;
  language: 'auto' | 'zh' | 'en';
  timestamps: TimestampGranularity;
  diarization: boolean;
  requestKey: string;
  signal?: AbortSignal;
};

export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: {
    timestamps: readonly TimestampGranularity[];
    diarization: boolean;
    languageDetection: boolean;
  };
  transcribe(input: TranscriptionInput): Promise<TranscriptResult>;
}

/** Provider HTTP 错误的统一分类，供 Worker 决定失败还是等待租约恢复。 */
export class TranscriptionProviderError extends Error {
  readonly provider: string;
  readonly status: number;

  constructor(provider: string, status: number, message: string) {
    super(message);
    this.provider = provider;
    this.status = status;
  }

  get transient(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}
