/**
 * 平台 HTTP API：单用户认证、应用/任务定义、任务控制面、Worker 协议和产物传输。
 * 本文件不包含任何播客或音频业务逻辑。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256 } from './crypto.ts';
import { PlatformError, Store, type TaskStatus } from './store.ts';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const WORKER_ACTIONS = new Set(['heartbeat', 'progress', 'logs', 'steps', 'artifacts', 'complete', 'fail']);

export type PlatformServerOptions = {
  artifactDir: string;
  leaseMs?: number;
  sweepMs?: number;
  schedulerMs?: number;
  scheduleGraceMs?: number;
  maxArtifactBytes?: number;
  requestLog?: (record: Record<string, unknown>) => void;
};

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new PlatformError(413, 'BODY_TOO_LARGE', '请求体超过大小限制');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new PlatformError(413, 'BODY_TOO_LARGE', '请求体超过大小限制');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const data = await readBody(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(data.toString('utf8')) as unknown;
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new PlatformError(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown, requestId: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  response.end(JSON.stringify(data));
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value || !value.startsWith('Bearer ') || value.length <= 7) {
    throw new PlatformError(401, 'UNAUTHENTICATED', '需要 Bearer Token');
  }
  return value.slice(7);
}

function requireUser(request: IncomingMessage, store: Store): { id: string } {
  const user = store.userForToken(bearerToken(request));
  if (!user) throw new PlatformError(401, 'UNAUTHENTICATED', '用户 Token 无效或已过期');
  return user;
}

function requireWorker(request: IncomingMessage, store: Store): { appId: string } {
  const worker = store.workerForToken(bearerToken(request));
  if (!worker) throw new PlatformError(401, 'UNAUTHENTICATED', 'Worker Token 无效');
  return worker;
}

function attemptId(request: IncomingMessage): string {
  const value = request.headers['x-attempt-id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlatformError(400, 'ATTEMPT_REQUIRED', '缺少 X-Attempt-Id');
  }
  return value;
}

function stringField(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PlatformError(400, 'INVALID_INPUT', `${key} 必须是非空字符串，最长 ${max} 字符`);
  }
  return value;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PlatformError(400, 'INVALID_PATH', '路径编码无效');
  }
}

function parseAfter(value: string | null, name: string): number {
  const parsed = Number(value ?? '0');
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError(400, 'INVALID_CURSOR', `${name} 游标无效`);
  }
  return parsed;
}

export function createPlatformServer(store: Store, options: PlatformServerOptions): Server {
  const leaseMs = options.leaseMs ?? 60_000;
  const maxArtifactBytes = options.maxArtifactBytes ?? 5 * 1024 * 1024;
  const loginAttempts = new Map<string, { count: number; until: number }>();

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    response.once('finish', () => {
      const record = {
        time: new Date(started).toISOString(),
        request_id: requestId,
        method: request.method,
        path: new URL(request.url ?? '/', 'http://localhost').pathname,
        status: response.statusCode,
        duration_ms: Date.now() - started,
      };
      if (options.requestLog) options.requestLog(record);
      else console.info(JSON.stringify(record));
    });

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = request.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return sendJson(response, 200, { ok: store.health() }, requestId);
      }

      if (method === 'POST' && path === '/v1/auth/login') {
        const remote = request.socket.remoteAddress ?? 'unknown';
        const current = loginAttempts.get(remote);
        if (current && current.until > Date.now() && current.count >= 10) {
          throw new PlatformError(429, 'RATE_LIMITED', '登录尝试过于频繁');
        }
        const body = await readJson(request);
        const username = stringField(body, 'username', 100);
        const password = stringField(body, 'password', 1024);
        try {
          const token = store.login(username, password);
          loginAttempts.delete(remote);
          return sendJson(response, 200, { token, expires_in_seconds: 90 * 24 * 60 * 60 }, requestId);
        } catch (error) {
          const next = current && current.until > Date.now() ? current.count + 1 : 1;
          loginAttempts.set(remote, { count: next, until: Date.now() + 60_000 });
          throw error;
        }
      }

      if (method === 'GET' && path === '/v1/apps') {
        requireUser(request, store);
        return sendJson(response, 200, { apps: store.listApps() }, requestId);
      }

      const appTasks = path.match(/^\/v1\/apps\/([^/]+)\/tasks$/);
      if (method === 'GET' && appTasks) {
        requireUser(request, store);
        return sendJson(response, 200, { tasks: store.listDefinitions(decodePath(appTasks[1])) }, requestId);
      }

      if (method === 'POST' && path === '/v1/apps') {
        requireUser(request, store);
        const body = await readJson(request);
        const result = store.upsertApp(body);
        return sendJson(response, 200, result, requestId);
      }

      const rotate = path.match(/^\/v1\/apps\/([^/]+)\/worker-token$/);
      if (method === 'POST' && rotate) {
        requireUser(request, store);
        const token = store.rotateWorkerToken(decodePath(rotate[1]));
        return sendJson(response, 200, { worker_token: token }, requestId);
      }

      if (method === 'POST' && path === '/v1/schedules') {
        requireUser(request, store);
        const body = await readJson(request);
        const appId = stringField(body, 'app_id', 100);
        const taskKey = stringField(body, 'task_key', 100);
        const cron = stringField(body, 'cron', 100);
        const timezone = stringField(body, 'timezone', 100);
        const enabled = body.enabled === undefined ? true : body.enabled;
        if (typeof enabled !== 'boolean') throw new PlatformError(400, 'INVALID_SCHEDULE', 'enabled 必须是 boolean');
        return sendJson(response, 201, {
          schedule: store.createSchedule(appId, taskKey, body.input, cron, timezone, enabled),
        }, requestId);
      }

      if (method === 'GET' && path === '/v1/schedules') {
        requireUser(request, store);
        return sendJson(response, 200, { schedules: store.listSchedules() }, requestId);
      }

      const scheduleRuns = path.match(/^\/v1\/schedules\/([^/]+)\/runs$/);
      if (method === 'GET' && scheduleRuns) {
        requireUser(request, store);
        return sendJson(response, 200, {
          runs: store.listScheduleRuns(decodePath(scheduleRuns[1])),
        }, requestId);
      }

      const scheduleRunNow = path.match(/^\/v1\/schedules\/([^/]+)\/run-now$/);
      if (method === 'POST' && scheduleRunNow) {
        requireUser(request, store);
        return sendJson(response, 200,
          store.runScheduleNow(decodePath(scheduleRunNow[1])), requestId);
      }

      const scheduleGet = path.match(/^\/v1\/schedules\/([^/]+)$/);
      if (method === 'GET' && scheduleGet) {
        requireUser(request, store);
        return sendJson(response, 200, store.getSchedule(decodePath(scheduleGet[1])), requestId);
      }

      if (method === 'PATCH' && scheduleGet) {
        requireUser(request, store);
        const body = await readJson(request);
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          throw new PlatformError(400, 'INVALID_SCHEDULE', 'enabled 必须是 boolean');
        }
        return sendJson(response, 200, {
          schedule: store.updateSchedule(decodePath(scheduleGet[1]), {
            input: body.input,
            cron: body.cron === undefined ? undefined : stringField(body, 'cron', 100),
            timezone: body.timezone === undefined ? undefined : stringField(body, 'timezone', 100),
            enabled: body.enabled as boolean | undefined,
          }),
        }, requestId);
      }

      if (method === 'DELETE' && scheduleGet) {
        requireUser(request, store);
        store.deleteSchedule(decodePath(scheduleGet[1]));
        return sendJson(response, 200, { ok: true }, requestId);
      }

      if (method === 'POST' && path === '/v1/tasks') {
        const user = requireUser(request, store);
        const body = await readJson(request);
        const fullName = stringField(body, 'task', 200);
        const slash = fullName.indexOf('/');
        if (slash <= 0) throw new PlatformError(400, 'INVALID_TASK_NAME', '任务名格式为 app_id/task_key');
        const appId = fullName.slice(0, slash);
        const taskKey = fullName.slice(slash + 1);
        const rawKey = request.headers['idempotency-key'];
        const idempotencyKey = typeof rawKey === 'string' ? rawKey : null;
        if (idempotencyKey !== null && (idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
          throw new PlatformError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键长度必须为 1–128 字符');
        }
        const result = store.createTask(`user:${user.id}`, appId, taskKey, body.input, idempotencyKey);
        return sendJson(response, result.reused ? 200 : 202, result, requestId);
      }

      if (method === 'GET' && path === '/v1/tasks') {
        requireUser(request, store);
        const status = url.searchParams.get('status') ?? undefined;
        if (status && !['queued', 'running', 'recovering', 'succeeded', 'failed', 'closed'].includes(status)) {
          throw new PlatformError(400, 'INVALID_STATUS', '任务状态筛选值无效');
        }
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        return sendJson(response, 200, store.listTasks({
          appId: url.searchParams.get('app_id') ?? undefined,
          taskKey: url.searchParams.get('task_key') ?? undefined,
          status: status as TaskStatus | undefined,
          scheduleId: url.searchParams.get('schedule_id') ?? undefined,
          limit,
          cursor: url.searchParams.get('cursor') ?? undefined,
        }), requestId);
      }

      const taskEvents = path.match(/^\/v1\/tasks\/([^/]+)\/events$/);
      if (method === 'GET' && taskEvents) {
        requireUser(request, store);
        const after = parseAfter(url.searchParams.get('after'), '事件');
        return sendJson(response, 200, { events: store.getEvents(decodePath(taskEvents[1]), after) }, requestId);
      }

      const taskLogs = path.match(/^\/v1\/tasks\/([^/]+)\/logs$/);
      if (method === 'GET' && taskLogs) {
        requireUser(request, store);
        const after = parseAfter(url.searchParams.get('after'), '日志');
        return sendJson(response, 200, { logs: store.getLogs(decodePath(taskLogs[1]), after) }, requestId);
      }

      const taskResult = path.match(/^\/v1\/tasks\/([^/]+)\/result$/);
      if (method === 'GET' && taskResult) {
        requireUser(request, store);
        const result = store.getResult(decodePath(taskResult[1]));
        const terminal = ['succeeded', 'failed', 'closed'].includes(result.status);
        return sendJson(response, terminal ? 200 : 202, result, requestId);
      }

      const taskClose = path.match(/^\/v1\/tasks\/([^/]+)\/close$/);
      if (method === 'POST' && taskClose) {
        const user = requireUser(request, store);
        const body = await readJson(request);
        const reason = typeof body.reason === 'string' && body.reason.length > 0
          ? body.reason.slice(0, 500) : 'manual';
        return sendJson(response, 200,
          store.close(decodePath(taskClose[1]), user.id, reason), requestId);
      }

      const taskRetry = path.match(/^\/v1\/tasks\/([^/]+)\/retry$/);
      if (method === 'POST' && taskRetry) {
        const user = requireUser(request, store);
        return sendJson(response, 202,
          store.retry(decodePath(taskRetry[1]), `user:${user.id}`), requestId);
      }

      const taskGet = path.match(/^\/v1\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskGet) {
        requireUser(request, store);
        return sendJson(response, 200, store.getTask(decodePath(taskGet[1])), requestId);
      }

      if (method === 'POST' && path === '/v1/worker/leases') {
        const worker = requireWorker(request, store);
        const lease = store.lease(worker.appId, leaseMs);
        if (!lease) {
          response.writeHead(204);
          response.end();
          return;
        }
        return sendJson(response, 200, lease, requestId);
      }

      const workerTask = path.match(/^\/v1\/worker\/tasks\/([^/]+)\/([a-z]+)$/);
      if (workerTask && WORKER_ACTIONS.has(workerTask[2])) {
        const worker = requireWorker(request, store);
        const taskId = decodePath(workerTask[1]);
        const action = workerTask[2];
        const currentAttempt = attemptId(request);

        if (method === 'POST' && action === 'heartbeat') {
          store.heartbeat(taskId, currentAttempt, worker.appId, leaseMs);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'POST' && action === 'progress') {
          const body = await readJson(request);
          const progress = body.progress;
          if (typeof progress !== 'number' || !Number.isInteger(progress) || progress < 0 || progress > 100) {
            throw new PlatformError(400, 'INVALID_PROGRESS', 'progress 必须是 0–100 的整数');
          }
          const message = typeof body.message === 'string' ? body.message.slice(0, 1000) : '';
          store.progress(taskId, currentAttempt, worker.appId, progress, message);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'POST' && action === 'logs') {
          const body = await readJson(request);
          if (!['debug', 'info', 'warn', 'error'].includes(String(body.level))) {
            throw new PlatformError(400, 'INVALID_LOG', 'level 必须是 debug、info、warn 或 error');
          }
          const message = stringField(body, 'message', 2000);
          store.log(taskId, currentAttempt, worker.appId, body.level as string, message);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'POST' && action === 'steps') {
          const body = await readJson(request);
          const stepKey = stringField(body, 'step_key', 100);
          if (!/^[a-zA-Z0-9._-]+$/.test(stepKey) || body.value === undefined) {
            throw new PlatformError(400, 'INVALID_STEP', '步骤键或结果无效');
          }
          store.saveStep(taskId, currentAttempt, worker.appId, stepKey, body.value);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'PUT' && action === 'artifacts') {
          const name = url.searchParams.get('name') ?? '';
          if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name)) {
            throw new PlatformError(400, 'INVALID_FILENAME', '文件名只允许字母、数字、点、下划线和连字符');
          }
          const data = await readBody(request, maxArtifactBytes);
          const id = randomUUID();
          const file = join(options.artifactDir, id);
          await mkdir(options.artifactDir, { recursive: true, mode: 0o700 });
          await writeFile(file, data, { flag: 'wx', mode: 0o600 });
          try {
            const rawContentType = request.headers['content-type'];
            const contentType = Array.isArray(rawContentType)
              ? rawContentType[0] ?? 'application/octet-stream'
              : rawContentType ?? 'application/octet-stream';
            store.createArtifact(taskId, currentAttempt, worker.appId, id, name,
              contentType, data.length, sha256(data));
          } catch (error) {
            await unlink(file).catch(() => {});
            throw error;
          }
          return sendJson(response, 201, { artifact_id: id, sha256: sha256(data), byte_size: data.length }, requestId);
        }
        if (method === 'POST' && action === 'complete') {
          const body = await readJson(request);
          if (!Object.prototype.hasOwnProperty.call(body, 'output')) {
            throw new PlatformError(400, 'INVALID_OUTPUT', '缺少 output');
          }
          return sendJson(response, 200,
            store.complete(taskId, currentAttempt, worker.appId, body.output), requestId);
        }
        if (method === 'POST' && action === 'fail') {
          const body = await readJson(request);
          const message = stringField(body, 'message', 1000);
          return sendJson(response, 200,
            store.fail(taskId, currentAttempt, worker.appId, message), requestId);
        }
      }

      const artifactGet = path.match(/^\/v1\/artifacts\/([^/]+)\/download$/);
      if (method === 'GET' && artifactGet) {
        requireUser(request, store);
        const artifactId = decodePath(artifactGet[1]);
        const artifact = store.getArtifactForDownload(artifactId);
        let data: Buffer;
        try {
          data = await readFile(join(options.artifactDir, artifactId));
        } catch {
          throw new PlatformError(503, 'ARTIFACT_UNAVAILABLE', '产物文件暂不可用');
        }
        if (data.length !== artifact.byte_size || sha256(data) !== artifact.sha256) {
          throw new PlatformError(503, 'ARTIFACT_CORRUPT', '产物文件校验失败');
        }
        response.writeHead(200, {
          'content-type': artifact.content_type,
          'content-length': data.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
          'cache-control': 'no-store',
          'x-request-id': requestId,
        });
        response.end(data);
        return;
      }

      throw new PlatformError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const known = error instanceof PlatformError;
      const status = known ? error.status : 500;
      const code = known ? error.code : 'INTERNAL_ERROR';
      const message = known ? error.message : '服务器内部错误';
      if (!known) console.error(`[${requestId}]`, error);
      sendJson(response, status, { error: { code, message, request_id: requestId } }, requestId);
    }
  });

  const timer = setInterval(() => {
    try { store.sweep(); }
    catch (error) { console.error('任务回收失败', error); }
  }, options.sweepMs ?? 5_000);
  timer.unref();

  const scheduler = setInterval(() => {
    try { store.schedulerTick(Date.now(), options.scheduleGraceMs ?? 5 * 60_000); }
    catch (error) { console.error('调度扫描失败', error); }
  }, options.schedulerMs ?? 5_000);
  scheduler.unref();
  server.on('close', () => {
    clearInterval(timer);
    clearInterval(scheduler);
  });
  return server;
}
