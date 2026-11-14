/** 本机音频实测：不提交任务、不入生产库；结果包含时长、分阶段耗时和运行版本。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WhisperCliProvider } from '../src/transcription/asr.ts';
import { PyannoteProvider, alignSpeakers } from '../src/transcription/diarization.ts';
import { audioDigest, mergeChunks, runFfmpeg, splitAudio } from '../src/transcription/worker.ts';
import { renderTranscriptMarkdown } from '../src/transcription/markdown.ts';
import { runProcess } from '../src/process.ts';
import { diagnosticMessage } from '../src/redact.ts';

function option(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${key}缺少参数`);
  return value;
}

async function measure(args: string[]): Promise<void> {
  const input = option(args, '--input');
  const output = option(args, '--output');
  if (!input || !output) throw new Error('用法: node scripts/benchmark-transcription.ts --input /path/audio.mp3 --output /path/report.json [--run-once]');
  const directory = await mkdtemp(join(tmpdir(), 'yuxun-benchmark-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const signal = controller.signal;
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  try {
    const wav = join(directory, 'audio.wav');
    const conversionStart = seconds();
    await runFfmpeg(resolve(input), wav, signal);
    const conversionSeconds = seconds() - conversionStart;
    const chunks = await splitAudio(wav, directory, 600, signal);
    const asr = async (wordTimestamps: boolean) => {
      const provider = new WhisperCliProvider({ wordTimestamps });
      const begin = seconds();
      const completed = [];
      for (const chunk of chunks) completed.push({ offset: chunk.offset,
        result: await provider.transcribe(chunk.path, 'zh', signal) });
      return { result: mergeChunks(completed), seconds: seconds() - begin };
    };
    console.log('计时1/3：原版Whisper');
    const v1 = await asr(false);
    console.log('计时2/3：Whisper词时间戳');
    const words = await asr(true);
    console.log('计时3/3：整集说话者分析（首次模型下载需单独预热）');
    const diarizer = new PyannoteProvider();
    const prepareStart = seconds();
    await diarizer.prepare(signal);
    const preparationSeconds = seconds() - prepareStart;
    const analysisStart = seconds();
    const speakers = await diarizer.analyze(wav, signal);
    const diarizationSeconds = seconds() - analysisStart;
    const alignStart = seconds();
    const segments = alignSpeakers(words.result.segments, speakers.turns);
    const alignmentSeconds = seconds() - alignStart;
    const { validateTranscript } = await import('../src/transcription/contract.ts');
    validateTranscript({ version: 2, text: words.result.text, segments, diarization: speakers.metadata });
    const report = { timestamp: new Date().toISOString(), audio_sha256: await audioDigest(wav),
      audio_seconds: chunks.reduce((sum, chunk) => sum + chunk.duration, 0),
      asr: { model: words.result.model, provider: words.result.provider,
        device: words.result.provider === 'mlx-whisper' ? 'mlx' : process.env.TRANSCRIPTION_WHISPER_DEVICE ?? 'cpu' },
      diarization: speakers.metadata, conversion_seconds: conversionSeconds,
      v1_asr_seconds: v1.seconds, v2_asr_words_seconds: words.seconds,
      model_preparation_seconds: preparationSeconds, diarization_seconds: diarizationSeconds,
      alignment_seconds: alignmentSeconds,
      v2_estimated_processing_seconds: conversionSeconds + words.seconds + preparationSeconds + diarizationSeconds + alignmentSeconds,
      note: '不含下载、排队与上传；Whisper每块重新加载模型，pyannote含加载。正式计时需缓存后独立运行三次。' };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(output + '.md', renderTranscriptMarkdown({ ...words.result, version: 2, segments,
      durationSeconds: report.audio_seconds, diarization: speakers.metadata }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<void> {
  if (process.platform === 'darwin' && !args.includes('--run-once')) {
    // /usr/bin/time 汇总子进程峰值RSS；报告保留原始单位，便于人工核对。
    const output = option(args, '--output');
    if (!output) throw new Error('需要--input和--output，完整用法见docs/transcription-v2.md');
    const memoryFile = resolve(output + '.memory.txt');
    // 由time写入，使用wx预留防止覆盖已有计时报告。
    await writeFile(memoryFile, '', { flag: 'wx', mode: 0o600 });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await runProcess('/usr/bin/time', ['-l', '-o', memoryFile, process.execPath,
        fileURLToPath(import.meta.url), ...args, '--run-once'], { timeoutMs: 24 * 60 * 60 * 1000, signal: controller.signal });
      console.log(result); console.log(`峰值内存报告：${memoryFile}`);
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } else await measure(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((error) => { console.error(diagnosticMessage(error)); process.exitCode = 1; });
}
