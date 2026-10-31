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
