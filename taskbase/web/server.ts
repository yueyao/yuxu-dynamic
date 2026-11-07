/**
 * 播客 Web 端：登录会话 + 平台管理 API 代理 + 播客领域 API + 静态页面。
 * 浏览器只拿到 Web 会话 Cookie，不接触平台 Owner Token 或 Worker Token。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodcastError, PodcastStore } from '../src/podcast/store.ts';
import { PODCAST_APP_ID, podcastManifest } from '../src/podcast/manifest.ts';
import { TRANSCRIPTION_APP_ID, transcriptionManifest } from '../src/transcription/manifest.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';
import { renderTranscriptMarkdown } from '../src/transcription/markdown.ts';

const MAX_JSON_BYTES = 256 * 1024;
const DEFAULT_PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');

type Session = { id: string; token: string; username: string; csrf: string; expiresAt: number };
type LoginAttempt = { count: number; until: number };

export type WebServerOptions = {
  platformUrl: string;
  dbPath: string;
  publicDir?: string;
  sessionTtlMs?: number;
  cookieSecure?: boolean;
  fetchImpl?: typeof fetch;
  transcriptApiToken?: string;
  requestLog?: (record: Record<string, unknown>) => void;
};

export class WebError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new WebError(413, 'BODY_TOO_LARGE', '请求体超过大小限制');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const data = await readBody(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(data.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
    return value as Record<string, unknown>;
  } catch {
    throw new WebError(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function stringField(body: Record<string, unknown>, key: string, max = 500): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new WebError(400, 'INVALID_INPUT', `${key} 必须是非空字符串，最长 ${max} 字符`);
  }
  return value.trim();
}

function optionalDate(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new WebError(400, 'INVALID_DATE', `${key} 必须是 YYYY-MM-DD`);
  }
  return value;
}

function dateQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new WebError(400, 'INVALID_DATE', `${key} 必须是 YYYY-MM-DD`);
  return value;
}

function getPathSuffix(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length) || '/';
}

function transcriptMetadata(transcript: ReturnType<TranscriptionStore['list']>[number]): Record<string, unknown> {
  return {
    transcript_id: transcript.transcript_id,
    task_id: transcript.task_id,
    episode_id: transcript.episode_id,
    show_id: transcript.show_id,
    title: transcript.title,
    language: transcript.language,
    provider: transcript.provider,
    model: transcript.model,
    duration_seconds: transcript.duration_seconds,
    segments: transcript.segments.length,
    created_at: transcript.created_at,
  };
}

function transcriptMarkdown(transcript: ReturnType<TranscriptionStore['list']>[number]): string {
  return renderTranscriptMarkdown({
    title: transcript.title,
    language: transcript.language,
    provider: transcript.provider,
    model: transcript.model,
    durationSeconds: transcript.duration_seconds,
    text: transcript.text,
    segments: transcript.segments,
  });
}

function sendMarkdown(response: ServerResponse, filename: string, markdown: string): void {
  response.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(markdown);
}

export function createWebServer(options: WebServerOptions): Server {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const cookieSecure = options.cookieSecure ?? process.env.TASKBASE_WEB_COOKIE_SECURE === '1';
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = new PodcastStore(options.dbPath);
  const transcriptionStore = new TranscriptionStore(options.dbPath);
  const transcriptionQueue = new TranscriptionQueueStore(options.dbPath);
  const transcriptApiToken = options.transcriptApiToken
    ?? process.env.TASKBASE_TRANSCRIPT_API_TOKEN ?? '';
  let queueRunnerToken: string | null = null;
  let queueTicking = false;
  const sessions = new Map<string, Session>();
  const loginAttempts = new Map<string, LoginAttempt>();

  const publicFiles: Record<string, { file: string; type: string }> = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  };

  function sessionFrom(request: IncomingMessage): Session | null {
    const id = parseCookies(request.headers.cookie).tb_session;
    if (!id) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) sessions.delete(id);
      return null;
    }
    return session;
  }

  function requireSession(request: IncomingMessage): Session {
    const session = sessionFrom(request);
    if (!session) throw new WebError(401, 'UNAUTHENTICATED', '请先登录');
    return session;
  }

  function requireCsrf(request: IncomingMessage, session: Session): void {
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || token !== session.csrf) {
      throw new WebError(403, 'CSRF_FAILED', 'CSRF 校验失败，请刷新页面');
    }
  }

  async function publicApiAuthorized(request: IncomingMessage): Promise<boolean> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const provided = header.slice(7);
    if (transcriptApiToken) {
      const left = Buffer.from(provided);
      const right = Buffer.from(transcriptApiToken);
      if (left.length === right.length && timingSafeEqual(left, right)) return true;
    }
    try {
      await platformJson('/v1/apps', { token: provided });
      return true;
    } catch {
      return false;
    }
  }

  async function handleTranscriptApi(response: ServerResponse, method: string,
    path: string, url: URL): Promise<void> {
    if (method !== 'GET') throw new WebError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    if (path === '/api/v1/queue') {
      const titles = new Map(store.listShows().map((show) => [show.show_id, show.title]));
      return sendJson(response, 200, {
        counts: transcriptionQueue.counts(),
        paused: transcriptionQueue.getState('paused') === '1',
        error: transcriptionQueue.getState('error'),
        runner: queueRunnerToken !== null,
        items: transcriptionQueue.list().map((item) => ({
          ...item,
          show_title: titles.get(item.show_id) ?? null,
        })),
      });
    }
    if (path === '/api/v1/transcripts') {
      const rawLimit = Number(url.searchParams.get('limit') ?? '20');
      const rawOffset = Number(url.searchParams.get('cursor') ?? '0');
      const { items, next_offset } = transcriptionStore.listPage({
        limit: Number.isFinite(rawLimit) ? rawLimit : 20,
        offset: Number.isFinite(rawOffset) ? rawOffset : 0,
        showId: url.searchParams.get('show_id') ?? undefined,
        episodeId: url.searchParams.get('episode_id') ?? undefined,
      });
      return sendJson(response, 200, {
        transcripts: items.map(transcriptMetadata),
        next_cursor: next_offset === null ? null : String(next_offset),
      });
    }

    const markdownMatch = path.match(/^\/api\/v1\/transcripts\/([^/]+)\/markdown$/);
    const detailMatch = path.match(/^\/api\/v1\/transcripts\/([^/]+)$/);
    if (markdownMatch || detailMatch) {
      const id = decodeURIComponent((markdownMatch ?? detailMatch)![1]);
      const transcript = transcriptionStore.getById(id);
      if (!transcript) throw new WebError(404, 'TRANSCRIPT_NOT_FOUND', '转写稿不存在');
      if (markdownMatch) {
        return sendMarkdown(response, `${transcript.transcript_id}.md`,
          transcriptMarkdown(transcript));
      }
      return sendJson(response, 200, { transcript });
    }

    throw new WebError(404, 'NOT_FOUND', '转写 API 不存在');
  }

  async function platformJson<T = any>(path: string, init: {
    method?: string; token?: string; body?: unknown;
  } = {}): Promise<T> {
    const response = await fetchImpl(new URL(path, options.platformUrl), {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const error = data as { error?: { code?: string; message?: string } } | null;
      throw new WebError(response.status, error?.error?.code ?? 'PLATFORM_ERROR',
        error?.error?.message ?? '平台请求失败');
    }
    return data as T;
  }

  async function platformCreateTask(token: string, task: string, input: unknown,
    appLabel = '目标应用'): Promise<any> {
    try {
      return await platformJson('/v1/tasks', { method: 'POST', token, body: { task, input } });
    } catch (error) {
      if (error instanceof WebError && (error.status === 404 || error.code === 'TASK_DEFINITION_NOT_FOUND')) {
        throw new WebError(409, 'APP_NOT_REGISTERED',
          `${appLabel}尚未注册或任务定义不存在，请先在“平台管理 → 应用”注册`);
      }
      throw error;
    }
  }

  async function queueTick(): Promise<void> {
    if (queueTicking || !queueRunnerToken) return;
    queueTicking = true;
    try {
      const running = transcriptionQueue.running();
      if (running?.task_id) {
        let task: { status: string; progress?: number; error?: string | null; close_reason?: string | null };
        try {
          task = await platformJson(`/v1/tasks/${encodeURIComponent(running.task_id)}`,
            { token: queueRunnerToken });
        } catch (error) {
          if (error instanceof WebError && error.status === 401) {
            queueRunnerToken = null;
            transcriptionQueue.setState('paused', '1');
            transcriptionQueue.setState('error', 'Web 登录已失效，请重新登录后点击开始');
          }
          return;
        }
        transcriptionQueue.updateProgress(running.id, task.progress ?? 0);
        if (task.status === 'succeeded') {
          try {
            await saveTranscriptFromTask(running.task_id, running, queueRunnerToken);
          } catch (error) {
            console.error('保存转写稿失败', error);
          }
          transcriptionQueue.markDone(running.id);
        } else if (task.status === 'failed') {
          transcriptionQueue.markFailed(running.id, task.error ?? '任务失败');
        } else if (task.status === 'closed') {
          transcriptionQueue.markFailed(running.id, task.close_reason ?? '任务已关闭');
        } else if (task.status === 'queued' && running.started_at
          && Date.now() - running.started_at > 10 * 60 * 1000) {
          await platformJson(`/v1/tasks/${encodeURIComponent(running.task_id)}/close`, {
            method: 'POST', token: queueRunnerToken, body: { reason: 'worker offline' },
          }).catch(() => {});
          transcriptionQueue.markFailed(running.id, 'Worker 10 分钟内未领取，队列已暂停');
          transcriptionQueue.setState('paused', '1');
          transcriptionQueue.setState('error', 'Worker 未领取任务，请确认 Worker 在线后点击继续');
        }
        return;
      }

      if (transcriptionQueue.getState('paused') === '1') return;
      const next = transcriptionQueue.next();
      if (!next) return;
      try {
        const created = await platformCreateTask(queueRunnerToken,
          `${TRANSCRIPTION_APP_ID}/episode/transcribe`, {
            audio_url: next.audio_url,
            episode_id: next.id,
            show_id: next.show_id,
            title: next.title,
            language: 'zh',
          }, '转写应用');
        transcriptionQueue.markRunning(next.id, created.task.task_id);
        transcriptionQueue.setState('error', null);
      } catch (error) {
        const message = error instanceof Error ? error.message : '提交任务失败';
        transcriptionQueue.markFailed(next.id, message);
        transcriptionQueue.setState('error', message);
        transcriptionQueue.setState('paused', '1');
      }
    } finally {
      queueTicking = false;
    }
  }

  async function saveTranscriptFromTask(taskId: string,
    item: { id: string; show_id: string; title: string }, token: string): Promise<boolean> {
    if (transcriptionStore.getByTask(taskId)) return false;
    const result = await platformJson<{ output?: Record<string, unknown> }>(
      `/v1/tasks/${encodeURIComponent(taskId)}/result`, { token });
    const output = result.output ?? {};
    if (typeof output.text !== 'string' || output.text.length === 0) return false;
    transcriptionStore.save({
      taskId,
      episodeId: item.id,
      showId: item.show_id,
      title: item.title,
      language: typeof output.language === 'string' ? output.language : 'zh',
      provider: typeof output.provider === 'string' ? output.provider : 'whisper-cli',
      model: typeof output.model === 'string' ? output.model : '',
      durationSeconds: typeof output.duration_seconds === 'number' ? output.duration_seconds : null,
      text: output.text,
      segments: Array.isArray(output.segments)
        ? output.segments as Array<{ start: number; end: number; text: string }>
        : [],
      artifactId: typeof output.artifact_id === 'string' ? output.artifact_id : null,
    });
    return true;
  }

  async function proxyPlatform(request: IncomingMessage, response: ServerResponse, session: Session,
    suffix: string, search: string): Promise<void> {
    const path = `/v1${suffix}${search}`;
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request, 5 * 1024 * 1024);
    const platformResponse = await fetchImpl(new URL(path, options.platformUrl), {
      method: request.method,
      headers: {
        authorization: `Bearer ${session.token}`,
        ...(body && body.length > 0 ? { 'content-type': request.headers['content-type'] ?? 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const contentType = platformResponse.headers.get('content-type') ?? 'application/json; charset=utf-8';
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'content-type': contentType };
    const disposition = platformResponse.headers.get('content-disposition');
    if (disposition) headers['content-disposition'] = disposition;
    const data = Buffer.from(await platformResponse.arrayBuffer());
    response.writeHead(platformResponse.status, headers);
    response.end(data);
  }

  function setSessionCookie(response: ServerResponse, id: string, maxAgeSeconds: number): void {
    response.setHeader('set-cookie',
      `tb_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${cookieSecure ? '; Secure' : ''}`);
  }

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    response.once('finish', () => {
      const record = {
        time: new Date(started).toISOString(), request_id: requestId,
        method: request.method, path: new URL(request.url ?? '/', 'http://localhost').pathname,
        status: response.statusCode, duration_ms: Date.now() - started,
      };
      if (options.requestLog) options.requestLog(record);
      else console.info(JSON.stringify(record));
    });

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const method = request.method ?? 'GET';
      const path = url.pathname;

      if (method === 'GET' && path === '/api/health') {
        return sendJson(response, 200, { ok: true });
      }

      if (path.startsWith('/api/v1/')) {
        if (!(await publicApiAuthorized(request))) {
          throw new WebError(401, 'UNAUTHORIZED', '无效的 API Token');
        }
        return await handleTranscriptApi(response, method, path, url);
      }

      if (method === 'GET' && publicFiles[path]) {
        const entry = publicFiles[path];
        const data = await readFile(resolve(publicDir, entry.file));
        response.writeHead(200, {
          'content-type': entry.type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'same-origin',
          'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
        });
        response.end(data);
        return;
      }

      if (method === 'GET' && path === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (method === 'POST' && path === '/api/login') {
        const remote = request.socket.remoteAddress ?? 'unknown';
        const attempt = loginAttempts.get(remote);
        if (attempt && attempt.until > Date.now() && attempt.count >= 10) {
          throw new WebError(429, 'RATE_LIMITED', '登录尝试过于频繁，请稍后再试');
        }
        const body = await readJson(request);
        const username = stringField(body, 'username', 100);
        const password = stringField(body, 'password', 1024);
        try {
          const result = await platformJson<{ token: string }>('/v1/auth/login', {
            method: 'POST', body: { username, password },
          });
          const id = randomUUID();
          const session: Session = {
            id, token: result.token, username, csrf: randomUUID(), expiresAt: Date.now() + sessionTtlMs,
          };
          sessions.set(id, session);
          loginAttempts.delete(remote);
          setSessionCookie(response, id, Math.floor(sessionTtlMs / 1000));
          return sendJson(response, 200, {
            username, csrf_token: session.csrf,
          });
        } catch (error) {
          const next = attempt && attempt.until > Date.now() ? attempt.count + 1 : 1;
          loginAttempts.set(remote, { count: next, until: Date.now() + 60_000 });
          throw error;
        }
      }

      if (method === 'POST' && path === '/api/logout') {
        const session = sessionFrom(request);
        if (session) sessions.delete(session.id);
        setSessionCookie(response, '', 0);
        return sendJson(response, 200, { ok: true });
      }

      if (method === 'GET' && path === '/api/me') {
        const session = requireSession(request);
        return sendJson(response, 200, { username: session.username, csrf_token: session.csrf });
      }

      const platformSuffix = getPathSuffix(path, '/api/platform');
      if (platformSuffix !== null) {
        const session = requireSession(request);
        if (method !== 'GET' && method !== 'HEAD') requireCsrf(request, session);
        return proxyPlatform(request, response, session, platformSuffix, url.search);
      }

      if (path.startsWith('/api/podcast/')) {
        const session = requireSession(request);
        if (method !== 'GET') requireCsrf(request, session);
        return await handlePodcast(request, response, session, method, path, url);
      }

      if (path.startsWith('/api/transcription/')) {
        const session = requireSession(request);
        if (method !== 'GET') requireCsrf(request, session);
        if (method === 'POST' && path === '/api/transcription/register') {
          return sendJson(response, 200, await platformJson('/v1/apps', {
            method: 'POST', token: session.token, body: transcriptionManifest,
          }));
        }
        return await handleTranscriptionQueue(request, response, session, method, path);
      }

      throw new WebError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof WebError || error instanceof PodcastError) {
        return sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      }
      console.error(`[${requestId}]`, error);
      return sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } });
    }
  });

  async function handleTranscriptionQueue(request: IncomingMessage, response: ServerResponse,
    session: Session, method: string, path: string): Promise<void> {
    if (method === 'GET' && path === '/api/transcription/queue') {
      return sendJson(response, 200, {
        items: transcriptionQueue.list(),
        counts: transcriptionQueue.counts(),
        paused: transcriptionQueue.getState('paused') === '1',
        error: transcriptionQueue.getState('error'),
        runner: queueRunnerToken !== null,
      });
    }

    if (method === 'POST' && path === '/api/transcription/queue') {
      const body = await readJson(request);
      const ids = Array.isArray(body.episode_ids)
        ? body.episode_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (ids.length === 0) throw new WebError(400, 'INVALID_INPUT', 'episode_ids 不能为空');
      const episodes = ids.map((id) => store.getEpisode(id)).filter((episode) => episode !== null);
      for (const episode of episodes) {
        if (!episode.audio_url) throw new WebError(409, 'AUDIO_URL_MISSING', `单集没有音频地址：${episode.title}`);
      }
      const result = transcriptionQueue.add(episodes.map((episode) => ({
        episode_id: episode.episode_id,
        show_id: episode.show_id,
        title: episode.title,
        audio_url: episode.audio_url ?? '',
      })));
      return sendJson(response, 200, { ...result, counts: transcriptionQueue.counts() });
    }

    if (method === 'POST' && path === '/api/transcription/queue/start') {
      queueRunnerToken = session.token;
      transcriptionQueue.setState('paused', '0');
      transcriptionQueue.setState('error', null);
      void queueTick();
      return sendJson(response, 200, { ok: true, runner: true });
    }

    if (method === 'POST' && path === '/api/transcription/queue/pause') {
      transcriptionQueue.setState('paused', '1');
      return sendJson(response, 200, { ok: true, paused: true });
    }

    if (method === 'POST' && path === '/api/transcription/queue/clear') {
      const removed = transcriptionQueue.clearFinished();
      return sendJson(response, 200, { ok: true, removed, counts: transcriptionQueue.counts() });
    }

    if (method === 'GET' && path === '/api/transcription/transcripts') {
      const titles = new Map(store.listShows().map((show) => [show.show_id, show.title]));
      return sendJson(response, 200, {
        transcripts: transcriptionStore.list(100).map((transcript) => ({
          transcript_id: transcript.transcript_id,
          task_id: transcript.task_id,
          episode_id: transcript.episode_id,
          show_id: transcript.show_id,
          show_title: transcript.show_id ? titles.get(transcript.show_id) ?? null : null,
          title: transcript.title,
          language: transcript.language,
          provider: transcript.provider,
          model: transcript.model,
          duration_seconds: transcript.duration_seconds,
          segments: transcript.segments.length,
          created_at: transcript.created_at,
        })),
      });
    }

    const transcriptMarkdownMatch = path.match(/^\/api\/transcription\/transcripts\/([^/]+)\/markdown$/);
    if (method === 'GET' && transcriptMarkdownMatch) {
      const transcript = transcriptionStore.getById(decodeURIComponent(transcriptMarkdownMatch[1]));
      if (!transcript) throw new WebError(404, 'TRANSCRIPT_NOT_FOUND', '转写稿不存在');
      return sendMarkdown(response, `${transcript.transcript_id}.md`,
        transcriptMarkdown(transcript));
    }

    const itemMatch = path.match(/^\/api\/transcription\/queue\/([^/]+)$/);
    if (itemMatch && method === 'PATCH') {
      const id = decodeURIComponent(itemMatch[1]);
      if (!transcriptionQueue.get(id)) throw new WebError(404, 'QUEUE_ITEM_NOT_FOUND', '队列项不存在');
      const body = await readJson(request);
      if (typeof body.enabled !== 'boolean') {
        throw new WebError(400, 'INVALID_INPUT', 'enabled 必须是 boolean');
      }
      return sendJson(response, 200, { item: transcriptionQueue.setEnabled(id, body.enabled) });
    }

    if (itemMatch && method === 'DELETE') {
      const id = decodeURIComponent(itemMatch[1]);
      try {
        if (!transcriptionQueue.remove(id)) throw new WebError(404, 'QUEUE_ITEM_NOT_FOUND', '队列项不存在');
      } catch (error) {
        if (error instanceof Error && !(error instanceof WebError)) {
          throw new WebError(409, 'QUEUE_ITEM_RUNNING', error.message);
        }
        throw error;
      }
      return sendJson(response, 200, { ok: true, counts: transcriptionQueue.counts() });
    }

    const moveMatch = path.match(/^\/api\/transcription\/queue\/([^/]+)\/move$/);
    if (moveMatch && method === 'POST') {
      const id = decodeURIComponent(moveMatch[1]);
      const body = await readJson(request);
      if (body.direction !== 'up' && body.direction !== 'down') {
        throw new WebError(400, 'INVALID_INPUT', 'direction 必须是 up 或 down');
      }
      const moved = transcriptionQueue.move(id, body.direction);
      if (!moved) throw new WebError(409, 'QUEUE_MOVE_FAILED', '已经在边界或队列项不存在');
      return sendJson(response, 200, { items: transcriptionQueue.list() });
    }

    const retryMatch = path.match(/^\/api\/transcription\/queue\/([^/]+)\/retry$/);
    if (retryMatch && method === 'POST') {
      const id = decodeURIComponent(retryMatch[1]);
      const item = transcriptionQueue.retry(id);
      if (!item) throw new WebError(404, 'QUEUE_ITEM_NOT_FOUND', '队列项不存在');
      return sendJson(response, 200, { item });
    }

    throw new WebError(404, 'NOT_FOUND', '转写队列接口不存在');
  }

  async function handlePodcast(request: IncomingMessage, response: ServerResponse, session: Session,
    method: string, path: string, url: URL): Promise<void> {
    if (method === 'GET' && path === '/api/podcast/manifest') {
      return sendJson(response, 200, { manifest: podcastManifest });
    }

    if (method === 'GET' && path === '/api/podcast/overview') {
      const apps = await platformJson<{ apps: Array<{ app_id: string }> }>('/v1/apps', { token: session.token });
      return sendJson(response, 200, {
        ...store.overview(),
        app_id: PODCAST_APP_ID,
        app_registered: apps.apps.some((app) => app.app_id === PODCAST_APP_ID),
        transcription_app_registered: apps.apps.some((app) => app.app_id === TRANSCRIPTION_APP_ID),
      });
    }

    if (method === 'POST' && path === '/api/podcast/register') {
      return sendJson(response, 200, await platformJson('/v1/apps', {
        method: 'POST', token: session.token, body: podcastManifest,
      }));
    }

    if (path === '/api/podcast/shows' && method === 'GET') {
      return sendJson(response, 200, { shows: store.listShows() });
    }

    if (method === 'GET' && path === '/api/podcast/runs') {
      return sendJson(response, 200, { runs: store.listRuns(undefined, 20) });
    }

    if (path === '/api/podcast/shows' && method === 'POST') {
      const body = await readJson(request);
      const show = store.addShow({
        url: stringField(body, 'url', 2000),
        title: typeof body.title === 'string' ? body.title : undefined,
        rssUrl: typeof body.rss_url === 'string' ? body.rss_url : undefined,
      });
      return sendJson(response, 201, { show });
    }

    const episodeTranscribe = path.match(/^\/api\/podcast\/episodes\/([^/]+)\/transcribe$/);
    if (episodeTranscribe && method === 'POST') {
      const episode = store.getEpisode(decodeURIComponent(episodeTranscribe[1]));
      if (!episode) throw new WebError(404, 'EPISODE_NOT_FOUND', '单集不存在');
      if (!episode.audio_url) throw new WebError(409, 'AUDIO_URL_MISSING', '该单集没有音频地址');
      const body = await readJson(request);
      const language = typeof body.language === 'string' ? body.language : 'zh';
      return sendJson(response, 202, await platformCreateTask(session.token,
        `${TRANSCRIPTION_APP_ID}/episode/transcribe`, {
          audio_url: episode.audio_url,
          episode_id: episode.episode_id,
          show_id: episode.show_id,
          title: episode.title,
          language,
        }, '转写应用'));
    }

    const episodeTranscript = path.match(/^\/api\/podcast\/episodes\/([^/]+)\/transcript$/);
    if (episodeTranscript && method === 'GET') {
      const episodeId = decodeURIComponent(episodeTranscript[1]);
      const local = transcriptionStore.getByEpisode(episodeId);
      if (local) return sendJson(response, 200, { transcript: local });

      // 远端 Worker 可能不在 Web/平台同一台机器：从平台任务输出恢复
      const tasks = await platformJson<{ tasks: Array<Record<string, any>> }>(
        '/v1/tasks?app_id=transcription-tools&limit=100', { token: session.token });
      const task = tasks.tasks.find((entry) => entry.status === 'succeeded'
        && entry.input && entry.input.episode_id === episodeId);
      if (!task) return sendJson(response, 200, { transcript: null });
      const result = await platformJson<{ output?: Record<string, any> }>(
        `/v1/tasks/${encodeURIComponent(task.task_id)}/result`, { token: session.token });
      const output = result.output ?? {};
      const segments = Array.isArray(output.segments) ? output.segments : [];
      return sendJson(response, 200, {
        transcript: {
          transcript_id: output.transcript_id ?? null,
          task_id: task.task_id,
          episode_id: episodeId,
          show_id: task.input.show_id ?? null,
          title: task.input.title ?? null,
          language: output.language ?? task.input.language ?? 'zh',
          provider: output.provider ?? 'whisper-cli',
          model: output.model ?? 'unknown',
          duration_seconds: output.duration_seconds ?? 0,
          text: output.text ?? segments.map((segment: any) => segment.text ?? '').join(''),
          segments,
          artifact_id: output.artifact_id ?? null,
          created_at: task.updated_at,
          source: 'platform',
        },
      });
    }

    const showMatch = path.match(/^\/api\/podcast\/shows\/([^/]+)$/);
    if (showMatch && method === 'GET') {
      return sendJson(response, 200, { show: store.getShow(decodeURIComponent(showMatch[1])) });
    }
    if (showMatch && method === 'PATCH') {
      const body = await readJson(request);
      const show = store.updateShow(decodeURIComponent(showMatch[1]), {
        title: body.title === undefined ? undefined : stringField(body, 'title', 200),
        rssUrl: body.rss_url === undefined ? undefined : (body.rss_url === null ? null : stringField(body, 'rss_url', 2000)),
      });
      return sendJson(response, 200, { show });
    }

    const episodesMatch = path.match(/^\/api\/podcast\/shows\/([^/]+)\/episodes$/);
    if (episodesMatch && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '200');
      return sendJson(response, 200, {
        episodes: store.listEpisodes(decodeURIComponent(episodesMatch[1]), Number.isSafeInteger(limit) ? limit : 200),
      });
    }

    const runsMatch = path.match(/^\/api\/podcast\/shows\/([^/]+)\/runs$/);
    if (runsMatch && method === 'GET') {
      return sendJson(response, 200, {
        runs: store.listRuns(decodeURIComponent(runsMatch[1]), 50),
      });
    }

    if (method === 'POST' && path === '/api/podcast/collect') {
      const body = await readJson(request);
      const showIds = Array.isArray(body.show_ids)
        ? body.show_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : store.listShows().map((show) => show.show_id);
      if (showIds.length === 0) throw new WebError(400, 'NO_SHOWS', '还没有可采集的节目');
      const since = optionalDate(body, 'since');
      const until = optionalDate(body, 'until');
      return sendJson(response, 202, await platformCreateTask(session.token, `${PODCAST_APP_ID}/shows/collect`, {
        show_ids: showIds, since, until,
      }));
    }

    const syncMatch = path.match(/^\/api\/podcast\/shows\/([^/]+)\/sync$/);
    if (syncMatch && method === 'POST') {
      const show = store.getShow(decodeURIComponent(syncMatch[1]));
      const body = await readJson(request);
      return sendJson(response, 202, await platformCreateTask(session.token, `${PODCAST_APP_ID}/show/sync`, {
        show_id: show.show_id,
        since: optionalDate(body, 'since'),
        until: optionalDate(body, 'until'),
      }));
    }

    const scheduleMatch = path.match(/^\/api\/podcast\/shows\/([^/]+)\/schedule$/);
    if (scheduleMatch && method === 'POST') {
      const show = store.getShow(decodeURIComponent(scheduleMatch[1]));
      const body = await readJson(request);
      const cron = stringField(body, 'cron', 100);
      const timezone = stringField(body, 'timezone', 100);
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        throw new WebError(400, 'INVALID_SCHEDULE', 'enabled 必须是 boolean');
      }
      const since = optionalDate(body, 'since');
      const until = optionalDate(body, 'until');
      return sendJson(response, 201, await platformJson('/v1/schedules', {
        method: 'POST', token: session.token,
        body: {
          app_id: PODCAST_APP_ID, task_key: 'show/sync', cron, timezone,
          input: { show_id: show.show_id, ...(since ? { since } : {}), ...(until ? { until } : {}) },
          enabled: body.enabled === undefined ? true : body.enabled,
        },
      }));
    }

    if (method === 'GET' && path === '/api/podcast/schedules') {
      const result = await platformJson<{ schedules: Array<Record<string, unknown>> }>('/v1/schedules',
        { token: session.token });
      const titles = new Map(store.listShows().map((show) => [show.show_id, show.title]));
      return sendJson(response, 200, {
        schedules: result.schedules
          .filter((schedule) => schedule.app_id === PODCAST_APP_ID)
          .map((schedule) => ({
            ...schedule,
            show_title: titles.get((schedule.input as { show_id?: string } | undefined)?.show_id ?? '') ?? null,
          })),
      });
    }

    throw new WebError(404, 'NOT_FOUND', '播客接口不存在');
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [remote, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(remote);
  }, 10 * 60_000);
  cleanup.unref();
  const queueTimer = setInterval(() => { void queueTick(); }, 10_000);
  queueTimer.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    clearInterval(queueTimer);
    transcriptionQueue.close();
    transcriptionStore.close();
    store.close();
  });
  return server;
}
