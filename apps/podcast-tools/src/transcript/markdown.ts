import type { ResolvedEpisode } from '../types.ts';
import type { TranscriptSegment } from '../transcription/provider.ts';

export function renderTranscriptMarkdown(input: {
  episode: ResolvedEpisode;
  language: string;
  durationSeconds: number;
  segments: TranscriptSegment[];
  timestamps?: 'none' | 'segment';
}): string {
  const body = input.segments.map((segment) => {
    const speaker = segment.speakerId ? ` ${segment.speakerId}` : '';
    const prefix = input.timestamps === 'none'
      ? speaker.trim()
      : `[${timestamp(segment.startMs)} - ${timestamp(segment.endMs)}]${speaker}`;
    return prefix ? `${prefix}\n${segment.text.trim()}` : segment.text.trim();
  }).join('\n\n');
  return [
    `# ${input.episode.title}`,
    '',
    `- 来源：${input.episode.platform}`,
    `- 原页面：${input.episode.canonicalUrl}`,
    `- 音频时长：${formatDuration(input.durationSeconds)}`,
    `- 转写语言：${input.language}`,
    '',
    '## 文字稿',
    '',
    body,
    '',
  ].join('\n');
}

export function renderTranscriptText(segments: TranscriptSegment[]): string {
  return `${segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n')}\n`;
}

function timestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  return timestamp(Math.round(seconds * 1000));
}
