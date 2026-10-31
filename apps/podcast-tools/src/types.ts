export type ResolvedEpisode = {
  platform: string;
  canonicalUrl: string;
  episodeId?: string;
  title: string;
  publisher?: string;
  publishedAt?: string;
  mediaUrl: string;
  mediaContentType?: string;
  declaredDurationSeconds?: number;
  resolverVersion: string;
};

export type PodcastTaskInput = {
  source_url: string;
  language?: 'auto' | 'zh' | 'en';
  timestamps?: 'none' | 'segment';
  speaker_diarization?: boolean;
  output_format?: 'text' | 'markdown';
  quality?: 'fast' | 'balanced' | 'accurate';
};
