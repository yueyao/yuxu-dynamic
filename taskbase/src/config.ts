import { resolve } from 'node:path';
import { envValue } from './env.ts';

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

const dataDir = resolve(envValue('YUXUN_DATA_DIR', 'TASKBASE_DATA_DIR', '.data') as string);

export const config = {
  dataDir,
  dbPath: resolve(dataDir, 'taskbase.sqlite'),
  artifactDir: resolve(dataDir, 'artifacts'),
  host: envValue('YUXUN_HOST', 'TASKBASE_HOST', '127.0.0.1') as string,
  port: positiveInt(envValue('YUXUN_PORT', 'TASKBASE_PORT'), 3333, 'YUXUN_PORT'),
  leaseMs: positiveInt(envValue('YUXUN_LEASE_MS', 'TASKBASE_LEASE_MS'), 60_000, 'YUXUN_LEASE_MS'),
  sweepMs: positiveInt(envValue('YUXUN_SWEEP_MS', 'TASKBASE_SWEEP_MS'), 5_000, 'YUXUN_SWEEP_MS'),
  schedulerMs: positiveInt(envValue('YUXUN_SCHEDULER_MS', 'TASKBASE_SCHEDULER_MS'), 5_000, 'YUXUN_SCHEDULER_MS'),
  scheduleGraceMs: positiveInt(envValue('YUXUN_SCHEDULE_GRACE_MS', 'TASKBASE_SCHEDULE_GRACE_MS'), 5 * 60_000, 'YUXUN_SCHEDULE_GRACE_MS'),
  maxArtifactBytes: positiveInt(envValue('YUXUN_MAX_ARTIFACT_BYTES', 'TASKBASE_MAX_ARTIFACT_BYTES'), 5 * 1024 * 1024, 'YUXUN_MAX_ARTIFACT_BYTES'),
  configDir: resolve(envValue('YUXUN_CONFIG_DIR', 'TASKBASE_CONFIG_DIR', resolve(process.env.HOME ?? '.', '.config', 'yuxun')) as string),
  ownerUsername: envValue('YUXUN_OWNER_USERNAME', 'TASKBASE_OWNER_USERNAME', 'owner') as string,
  platformUrl: envValue('YUXUN_URL', 'TASKBASE_URL', 'http://127.0.0.1:3333') as string,
  webHost: envValue('YUXUN_WEB_HOST', 'TASKBASE_WEB_HOST', '127.0.0.1') as string,
  webPort: positiveInt(envValue('YUXUN_WEB_PORT', 'TASKBASE_WEB_PORT'), 3334, 'YUXUN_WEB_PORT'),
  webSessionTtlMs: positiveInt(envValue('YUXUN_WEB_SESSION_TTL_MS', 'TASKBASE_WEB_SESSION_TTL_MS'), 12 * 60 * 60 * 1000, 'YUXUN_WEB_SESSION_TTL_MS'),
};
