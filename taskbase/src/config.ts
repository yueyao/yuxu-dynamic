import { resolve } from 'node:path';

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

const dataDir = resolve(process.env.TASKBASE_DATA_DIR ?? '.data');

export const config = {
  dataDir,
  dbPath: resolve(dataDir, 'taskbase.sqlite'),
  artifactDir: resolve(dataDir, 'artifacts'),
  host: process.env.TASKBASE_HOST ?? '127.0.0.1',
  port: positiveInt(process.env.TASKBASE_PORT, 3333, 'TASKBASE_PORT'),
  leaseMs: positiveInt(process.env.TASKBASE_LEASE_MS, 60_000, 'TASKBASE_LEASE_MS'),
  sweepMs: positiveInt(process.env.TASKBASE_SWEEP_MS, 5_000, 'TASKBASE_SWEEP_MS'),
  schedulerMs: positiveInt(process.env.TASKBASE_SCHEDULER_MS, 5_000, 'TASKBASE_SCHEDULER_MS'),
  scheduleGraceMs: positiveInt(process.env.TASKBASE_SCHEDULE_GRACE_MS, 5 * 60_000, 'TASKBASE_SCHEDULE_GRACE_MS'),
  maxArtifactBytes: positiveInt(process.env.TASKBASE_MAX_ARTIFACT_BYTES, 5 * 1024 * 1024, 'TASKBASE_MAX_ARTIFACT_BYTES'),
  configDir: resolve(process.env.TASKBASE_CONFIG_DIR ?? resolve(process.env.HOME ?? '.', '.config', 'taskbase')),
  ownerUsername: process.env.TASKBASE_OWNER_USERNAME ?? 'owner',
  platformUrl: process.env.TASKBASE_URL ?? 'http://127.0.0.1:3333',
  webHost: process.env.TASKBASE_WEB_HOST ?? '127.0.0.1',
  webPort: positiveInt(process.env.TASKBASE_WEB_PORT, 3334, 'TASKBASE_WEB_PORT'),
  webSessionTtlMs: positiveInt(process.env.TASKBASE_WEB_SESSION_TTL_MS, 12 * 60 * 60 * 1000, 'TASKBASE_WEB_SESSION_TTL_MS'),
};
