/** 测试专用 fetch 适配器：把独立客户端进程的请求交给父进程转发。 */
type ResponseMessage = {
  kind: 'http-response';
  id: number;
  status: number;
  headers: Record<string, string>;
  body: string;
};

let nextId = 1;
const pending = new Map<number, { resolve: (value: Response) => void; reject: (error: Error) => void }>();
process.channel?.unref();

process.on('message', (raw: unknown) => {
  const message = raw as ResponseMessage;
  if (message?.kind !== 'http-response') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (pending.size === 0) process.channel?.unref();
  entry.resolve(new Response(message.status === 204 ? null : Buffer.from(message.body, 'base64'), {
    status: message.status,
    headers: message.headers,
  }));
});

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (!process.send) throw new Error('测试进程没有 IPC 通道');
  const id = nextId++;
  const url = input instanceof Request ? input.url : String(input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body == null ? Buffer.alloc(0) :
    typeof init.body === 'string' ? Buffer.from(init.body) :
      init.body instanceof Uint8Array ? Buffer.from(init.body) :
        (() => { throw new Error('测试 fetch 不支持此请求体类型'); })();
  if (body.length > 0) headers['content-length'] = String(body.length);
  return new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) { reject(new Error('请求已中止')); return; }
    pending.set(id, { resolve, reject });
    process.channel?.ref();
    process.send?.({
      kind: 'http-request', id, url, method: init?.method ?? 'GET',
      headers, body: body.toString('base64'),
    });
  });
};
