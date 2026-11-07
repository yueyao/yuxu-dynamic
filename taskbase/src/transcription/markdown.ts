/** 转写稿 Markdown 渲染：Worker 产物和对外导出共用同一份格式。 */
export type TranscriptMarkdownSegment = { start: number; end: number; text: string };

export type TranscriptMarkdownInput = {
  title?: string | null;
  language: string;
  provider: string;
  model: string;
  durationSeconds: number | null;
  text: string;
  segments: TranscriptMarkdownSegment[];
};

export function timestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const rest = (total % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${rest}`;
}

export function renderTranscriptMarkdown(input: TranscriptMarkdownInput): string {
  const lines = [
    `# ${input.title ?? '转写稿'}`,
    '',
    `- 语言：${input.language}`,
    `- 时长：${timestamp(input.durationSeconds ?? 0)}`,
    `- 引擎：${input.provider} / ${input.model}`,
    '',
    '## 文字稿',
    '',
    input.text,
  ];
  if (input.segments.length > 0) {
    lines.push('', '## 时间戳', '');
    for (const segment of input.segments) {
      lines.push(`- [${timestamp(segment.start)} → ${timestamp(segment.end)}] ${segment.text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
