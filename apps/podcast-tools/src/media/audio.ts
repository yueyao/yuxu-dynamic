import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AudioMetadata = {
  formatName: string;
  codecName: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
};

export type AudioToolOptions = {
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
  signal?: AbortSignal;
};

export type AudioSegment = {
  index: number;
  path: string;
  startMs: number;
  endMs: number;
  durationSeconds: number;
};

/** 以 ffprobe 的实际媒体信息为准，不信任扩展名或 HTTP Content-Type。 */
export async function probeAudio(audioPath: string, options: AudioToolOptions = {}): Promise<AudioMetadata> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(options.ffprobeExecutable ?? 'ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'format=format_name,duration:stream=codec_name,sample_rate,channels',
      '-of', 'json',
      audioPath,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024, signal: options.signal }));
  } catch (error) {
    throw new Error(`MEDIA_UNSUPPORTED: ffprobe 无法读取音频：${commandError(error)}`);
  }

  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error('MEDIA_UNSUPPORTED: ffprobe 返回了无效 JSON'); }
  const root = record(value);
  const format = record(root?.format);
  const stream = Array.isArray(root?.streams) ? record(root.streams[0]) : undefined;
  const durationSeconds = Number(format?.duration);
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  if (!format || !stream || typeof format.format_name !== 'string' ||
    typeof stream.codec_name !== 'string' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
    !Number.isSafeInteger(sampleRate) || sampleRate <= 0 ||
    !Number.isSafeInteger(channels) || channels <= 0) {
    throw new Error('MEDIA_UNSUPPORTED: 音频缺少有效格式、时长、采样率或声道信息');
  }
  return {
    formatName: format.format_name,
    codecName: stream.codec_name,
    durationSeconds,
    sampleRate,
    channels,
  };
}

/** 生成供转写 Provider 使用的 16 kHz 单声道 FLAC 工作副本。 */
export async function normalizeAudio(inputPath: string, outputPath: string,
  options: AudioToolOptions = {}): Promise<AudioMetadata> {
  try {
    await execFileAsync(options.ffmpegExecutable ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac',
      outputPath,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, signal: options.signal });
  } catch (error) {
    throw new Error(`MEDIA_UNSUPPORTED: ffmpeg 标准化失败：${commandError(error)}`);
  }
  return probeAudio(outputPath, options);
}

/** 将标准化音频切成可恢复的固定上限片段；当前 V1 使用 300 秒上限。 */
export async function segmentAudio(inputPath: string, outputDir: string,
  segmentSeconds = 300, options: AudioToolOptions = {}): Promise<AudioSegment[]> {
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
    throw new Error('MEDIA_SEGMENT_INVALID: 切片时长必须为正数');
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const inputMetadata = await probeAudio(inputPath, options);
  const count = Math.ceil(inputMetadata.durationSeconds / segmentSeconds);
  const segments: AudioSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const startSeconds = index * segmentSeconds;
    const requestedDuration = Math.min(segmentSeconds, inputMetadata.durationSeconds - startSeconds);
    const path = join(outputDir, `segment-${String(index).padStart(6, '0')}.flac`);
    try {
      // FLAC 通过 segment muxer 切片时可能缺少每片时长元数据，因此按确定范围逐片编码。
      await execFileAsync(options.ffmpegExecutable ?? 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
        '-ss', String(startSeconds), '-t', String(requestedDuration),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', path,
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, signal: options.signal });
    } catch (error) {
      throw new Error(`MEDIA_SEGMENT_FAILED: ffmpeg 切片失败：${commandError(error)}`);
    }
    const metadata = await probeAudio(path, options);
    const startMs = Math.round(startSeconds * 1000);
    const durationMs = Math.round(metadata.durationSeconds * 1000);
    const endMs = Math.min(Math.round(inputMetadata.durationSeconds * 1000), startMs + durationMs);
    segments.push({ index, path, startMs, endMs,
      durationSeconds: metadata.durationSeconds });
  }
  if (segments.length === 0) throw new Error('MEDIA_SEGMENT_FAILED: 未生成音频片段');
  return segments;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function commandError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error &&
    typeof (error as { stderr: unknown }).stderr === 'string') {
    return (error as { stderr: string }).stderr.trim().slice(0, 500) || '命令执行失败';
  }
  return error instanceof Error ? error.message : '命令执行失败';
}
