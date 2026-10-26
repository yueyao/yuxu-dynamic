/**
 * 平台 HTTP API：完成请求校验、主体认证、路由分发和文件传输。
 * 任务状态由 Store 持久化；此模块还负责周期性回收过期租约。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AppError, Store } from '../../../packages/core/src/store.ts';
import { sha256 } from '../../../packages/core/src/crypto.ts';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

type Options = {
  artifactDir: string;
  leaseMs?: number;
  sweepMs?: number;
  /** 每个请求一条结构化运行日志；测试可注入空实现。 */
  requestLog?: (record: Record<string, unknown>) => void;
};

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new AppError(413, 'BODY_TOO_LARGE', '请求体超过大小限制');
  }
  // 读取流时逐块限制大小；分块请求可以没有 Content-Length，也可能伪造该字段。
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new AppError(413, 'BODY_TOO_LARGE', '请求体超过大小限制');
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
    throw new AppError(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
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
    throw new AppError(401, 'UNAUTHENTICATED', '需要 Bearer Token');
  }
  return value.slice(7);
}

function requireUser(request: IncomingMessage, store: Store): { id: string } {
  const user = store.userForToken(bearerToken(request));
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'CLI Token 无效或已过期');
  return user;
}

function requireWorker(request: IncomingMessage, store: Store): { appId: string; releaseDigest: string } {
  const worker = store.workerForToken(bearerToken(request));
  if (!worker) throw new AppError(401, 'UNAUTHENTICATED', 'Worker Token 无效');
  return worker;
}

function requireAttemptId(request: IncomingMessage): string {
  const value = request.headers['x-attempt-id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'ATTEMPT_REQUIRED', '缺少 X-Attempt-Id');
  }
  return value;
}

function stringField(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new AppError(400, 'INVALID_INPUT', `${key} 必须是非空字符串，最长 ${max} 字符`);
  }
  return value;
}

/** 创建可嵌入测试的 HTTP 服务；调用方负责监听端口和关闭 Store。 */
export function createApiServer(store: Store, options: Options): Server {
  const leaseMs = options.leaseMs ?? 60_000;
  const sweepMs = options.sweepMs ?? 5_000;
  const loginAttempts = new Map<string, { count: number; until: number }>();

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    // 只记录路径和状态，不记录 URL 查询、请求体或 Bearer Token。
    response.once('finish', () => {
      const record = { time: new Date(started).toISOString(), request_id: requestId,
        method: request.method, path: new URL(request.url ?? '/', 'http://localhost').pathname,
        status: response.statusCode, duration_ms: Date.now() - started };
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

      if (method === 'POST' && path === '/v1/auth/cli-token') {
        const remote = request.socket.remoteAddress ?? 'unknown';
        const current = loginAttempts.get(remote);
        if (current && current.until > Date.now() && current.count >= 10) {
          throw new AppError(429, 'RATE_LIMITED', '登录尝试过于频繁');
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
        const appId = decodeURIComponent(appTasks[1]);
        return sendJson(response, 200, { tasks: store.listDefinitions(appId) }, requestId);
      }

      if (method === 'POST' && path === '/v1/tasks') {
        const user = requireUser(request, store);
        const body = await readJson(request);
        const fullName = stringField(body, 'task', 200);
        const slash = fullName.indexOf('/');
        if (slash <= 0) throw new AppError(400, 'INVALID_TASK_NAME', '任务名格式为 app_id/task_key');
        const appId = fullName.slice(0, slash);
        const taskKey = fullName.slice(slash + 1);
        const rawKey = request.headers['idempotency-key'];
        const idempotencyKey = typeof rawKey === 'string' ? rawKey : null;
        if (idempotencyKey !== null && (idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
          throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键长度必须为 1 至 128 字符');
        }
        let scheduledAt: number | null = null;
        if (body.run_at !== undefined && body.run_at !== null) {
          if (typeof body.run_at !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.run_at)) {
            throw new AppError(400, 'INVALID_RUN_AT', 'run_at 必须是带时区的 ISO 8601 时间');
          }
          scheduledAt = Date.parse(body.run_at);
          if (!Number.isFinite(scheduledAt)) {
            throw new AppError(400, 'INVALID_RUN_AT', 'run_at 时间无效');
          }
        }
        const result = store.createTask(`user:${user.id}`, appId, taskKey, body.input, idempotencyKey, scheduledAt);
        return sendJson(response, result.reused ? 200 : 202, result, requestId);
      }

      if (method === 'GET' && path === '/v1/tasks') {
        requireUser(request, store);
        const status = url.searchParams.get('status') ?? undefined;
        if (status && !['queued', 'running', 'recovering', 'succeeded', 'failed'].includes(status)) {
          throw new AppError(400, 'INVALID_STATUS', '任务状态筛选值无效');
        }
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        return sendJson(response, 200, store.listTasks({
          appId: url.searchParams.get('app_id') ?? undefined,
          taskKey: url.searchParams.get('task_key') ?? undefined,
          status: status as Parameters<Store['listTasks']>[0]['status'],
          limit, cursor: url.searchParams.get('cursor') ?? undefined,
        }), requestId);
      }

      const taskEvents = path.match(/^\/v1\/tasks\/([^/]+)\/events$/);
      if (method === 'GET' && taskEvents) {
        requireUser(request, store);
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) throw new AppError(400, 'INVALID_CURSOR', '事件游标无效');
        return sendJson(response, 200, { events: store.getEvents(taskEvents[1], after) }, requestId);
      }
      const taskLogs = path.match(/^\/v1\/tasks\/([^/]+)\/logs$/);
      if (method === 'GET' && taskLogs) {
        requireUser(request, store);
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) throw new AppError(400, 'INVALID_CURSOR', '日志游标无效');
        return sendJson(response, 200, { logs: store.getLogs(taskLogs[1], after) }, requestId);
      }
      const taskResult = path.match(/^\/v1\/tasks\/([^/]+)\/result$/);
      if (method === 'GET' && taskResult) {
        requireUser(request, store);
        const result = store.getResult(taskResult[1]);
        return sendJson(response, ['succeeded', 'failed'].includes(result.status) ? 200 : 202, result, requestId);
      }
      const taskGet = path.match(/^\/v1\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskGet) {
        requireUser(request, store);
        return sendJson(response, 200, store.getTask(taskGet[1]), requestId);
      }

      if (method === 'POST' && path === '/v1/worker/leases') {
        const worker = requireWorker(request, store);
        const lease = store.lease(worker.appId, worker.releaseDigest, leaseMs);
        if (!lease) { response.writeHead(204); response.end(); return; }
        return sendJson(response, 200, lease, requestId);
      }

      const workerTask = path.match(/^\/v1\/worker\/tasks\/([^/]+)\/(heartbeat|progress|complete|fail|steps|artifacts|logs)$/);
      if (workerTask) {
        const worker = requireWorker(request, store);
        const taskId = workerTask[1];
        const action = workerTask[2];
        const attemptId = requireAttemptId(request);
        if (method === 'POST' && action === 'heartbeat') {
          store.heartbeat(taskId, attemptId, worker.appId, leaseMs);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'POST' && action === 'progress') {
          const body = await readJson(request);
          const progress = body.progress;
          if (typeof progress !== 'number' || !Number.isInteger(progress) || progress < 0 || progress > 100) {
            throw new AppError(400, 'INVALID_PROGRESS', 'progress 必须是 0 至 100 的整数');
          }
          const message = typeof body.message === 'string' ? body.message.slice(0, 1000) : '';
          store.progress(taskId, attemptId, worker.appId, progress, message);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'POST' && action === 'logs') {
          const body = await readJson(request);
          if (!['debug', 'info', 'warn', 'error'].includes(String(body.level))) {
            throw new AppError(400, 'INVALID_LOG', 'level 必须是 debug、info、warn 或 error');
          }
          const message = stringField(body, 'message', 2000);
          store.log(taskId, attemptId, worker.appId, body.level as string, message);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'POST' && action === 'steps') {
          const body = await readJson(request);
          const stepKey = stringField(body, 'step_key', 100);
          if (!/^[a-zA-Z0-9._-]+$/.test(stepKey) || body.value === undefined) {
            throw new AppError(400, 'INVALID_STEP', '步骤键或结果无效');
          }
          store.saveStep(taskId, attemptId, worker.appId, stepKey, body.value);
          return sendJson(response, 200, { ok: true }, requestId);
        }
        if (method === 'PUT' && action === 'artifacts') {
          const name = url.searchParams.get('name') ?? '';
          if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name)) {
            throw new AppError(400, 'INVALID_FILENAME', '文件名只允许字母、数字、点、下划线和连字符');
          }
          store.assertCurrentAttempt(taskId, attemptId, worker.appId);
          const data = await readBody(request, MAX_ARTIFACT_BYTES);
          const id = randomUUID();
          await mkdir(options.artifactDir, { recursive: true, mode: 0o700 });
          const file = join(options.artifactDir, id);
          await writeFile(file, data, { flag: 'wx', mode: 0o600 });
          try {
            store.createArtifact(taskId, attemptId, worker.appId, id, name,
              'text/plain; charset=utf-8', data.length, sha256(data));
          } catch (error) {
            await unlink(file);
            throw error;
          }
          return sendJson(response, 201, { artifact_id: id, sha256: sha256(data) }, requestId);
        }
        if (method === 'POST' && action === 'complete') {
          const body = await readJson(request);
          // 兼容旧 Worker 的 {artifact_id}，新 Worker 用 {output} 返回结构化结果。
          const output = Object.prototype.hasOwnProperty.call(body, 'output')
            ? body.output : { artifact_id: stringField(body, 'artifact_id', 100) };
          return sendJson(response, 200,
            store.complete(taskId, attemptId, worker.appId, output), requestId);
        }
        if (method === 'POST' && action === 'fail') {
          const body = await readJson(request);
          const message = stringField(body, 'message', 1000);
          return sendJson(response, 200,
            store.fail(taskId, attemptId, worker.appId, message), requestId);
        }
      }

      const artifactGet = path.match(/^\/v1\/artifacts\/([^/]+)\/download$/);
      if (method === 'GET' && artifactGet) {
        requireUser(request, store);
        const artifact = store.getArtifactForDownload(artifactGet[1]);
        let data: Buffer;
        try { data = await readFile(join(options.artifactDir, artifactGet[1])); }
        catch { throw new AppError(503, 'ARTIFACT_UNAVAILABLE', '产物文件暂不可用'); }
        if (data.length !== artifact.byte_size || sha256(data) !== artifact.sha256) {
          throw new AppError(503, 'ARTIFACT_CORRUPT', '产物文件校验失败');
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

      throw new AppError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const known = error instanceof AppError;
      const status = known ? error.status : 500;
      const code = known ? error.code : 'INTERNAL_ERROR';
      const message = known ? error.message : '服务器内部错误';
      // 不向客户端泄露 SQL 错误或文件路径；运维人员通过请求 ID 定位服务端日志。
      if (!known) console.error(`[${requestId}]`, error);
      sendJson(response, status, { error: { code, message, request_id: requestId } }, requestId);
    }
  });

  const timer = setInterval(() => {
    try { store.recoverExpired(); }
    catch (error) { console.error('租约回收失败', error); }
  }, sweepMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}
