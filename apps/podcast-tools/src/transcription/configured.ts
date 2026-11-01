import { createElevenLabsProvider } from './elevenlabs.ts';
import { createFunASRProvider } from './funasr.ts';
import type { TranscriptionProvider } from './provider.ts';

export type TranscriptionEnvironment = Record<string, string | undefined>;

/** 将部署配置映射为 Provider；默认始终为自托管 FunASR。 */
export function createConfiguredTranscriptionProvider(
  environment: TranscriptionEnvironment = process.env,
  dependencies: { fetchImpl?: typeof fetch } = {},
): TranscriptionProvider {
  const name = environment.TRANSCRIPTION_PROVIDER?.trim().toLowerCase() || 'funasr';
  const requestTimeoutMs = optionalPositiveInteger(environment.TRANSCRIPTION_REQUEST_TIMEOUT_MS,
    'TRANSCRIPTION_REQUEST_TIMEOUT_MS');
  if (name === 'funasr') {
    return createFunASRProvider({
      baseUrl: environment.FUNASR_BASE_URL,
      model: environment.TRANSCRIPTION_MODEL,
      deploymentId: environment.FUNASR_DEPLOYMENT_ID?.trim() || 'funasr-1.4.19-cpu',
      bearerToken: environment.FUNASR_API_TOKEN,
      fetchImpl: dependencies.fetchImpl,
      requestTimeoutMs,
    });
  }
  if (name === 'elevenlabs') {
    return createElevenLabsProvider({
      apiKey: environment.ELEVENLABS_API_KEY ?? '',
      model: environment.TRANSCRIPTION_MODEL,
      fetchImpl: dependencies.fetchImpl,
      requestTimeoutMs,
    });
  }
  throw new Error(`TRANSCRIPTION_CONFIG_INVALID: 不支持的 TRANSCRIPTION_PROVIDER=${name}`);
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`TRANSCRIPTION_CONFIG_INVALID: ${name} 必须是正整数`);
  }
  return parsed;
}
