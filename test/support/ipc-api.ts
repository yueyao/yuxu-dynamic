/** 测试专用 API 进程：接收 IPC 请求后交给生产 HTTP 路由处理。 */
import { EventEmitter, once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createApiServer } from '../../apps/platform-api/src/server.ts';
import { Store } from '../../packages/core/src/store.ts';

type RequestMessage = {
  kind: 'http-request';
  route: string;
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

class LocalResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  headersSent = false;

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
    this.headersSent = true;
    return this;
  }

  end(data?: string | Buffer): void {
    if (data) this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    this.emit('finish');
  }

  destroy(): void { this.emit('finish'); }
}

const dataDir = resolve(process.env.PLATFORM_DATA_DIR ?? '.local');
const store = new Store(resolve(dataDir, 'platform.sqlite'));
const server = createApiServer(store, { artifactDir: resolve(dataDir, 'artifacts'), sweepMs: 20 });

process.on('message', async (raw: unknown) => {
  const message = raw as RequestMessage;
  if (message?.kind !== 'http-request') return;
  const request = new PassThrough();
  const url = new URL(message.url);
  Object.assign(request, {
    url: `${url.pathname}${url.search}`,
    method: message.method,
    headers: message.headers,
    socket: { remoteAddress: 'process-boundary-test' },
  });
  const response = new LocalResponse();
  const finished = once(response, 'finish');
  request.end(Buffer.from(message.body, 'base64'));
  server.emit('request', request as unknown as IncomingMessage, response as unknown as ServerResponse);
  await finished;
  process.send?.({
    kind: 'http-response', route: message.route, id: message.id,
    status: response.status, headers: response.headers,
    body: Buffer.concat(response.chunks).toString('base64'),
  });
});

process.on('SIGTERM', () => {
  server.emit('close');
  store.close();
  process.exit(0);
});

process.send?.({ kind: 'ready' });
