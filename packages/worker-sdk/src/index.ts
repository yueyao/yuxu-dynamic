/** Worker 与平台 `/v1/worker` API 的通信契约和客户端实现。 */
export type WorkerLease = {
  task_id: string;
  attempt_id: string;
  app_id: string;
  task_key: string;
  release_digest: string;
  input: unknown;
  steps: Record<string, unknown>;
};

export type WorkerClientOptions = {
  baseUrl: string;
  token: string;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export class RemoteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 判断错误是否应交给租约回收，而非记为任务自身失败。 */
export function isTransientWorkerError(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof RemoteError && (error.status >= 500 || error.status === 429)) ||
    (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name));
}

/** 支持 AbortSignal 的等待，用于轮询和示例任务。 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveSleep, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('已中止')); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('已中止'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 统一处理 Worker 通信、心跳和检查点，应用处理器只保留任务逻辑。 */
export class WorkerClient {
  private readonly options: WorkerClientOptions;

  constructor(options: WorkerClientOptions) {
    this.options = options;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // 超时的写请求可能已到达 API；服务端依靠 attempt_id 和幂等完成语义隔离重试。
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    const response = await (this.options.fetchImpl ?? fetch)(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal,
    });
    if (response.status === 204) return null as T;
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { code?: string; message?: string } | undefined;
      throw new RemoteError(response.status, error?.code ?? 'REMOTE_ERROR', error?.message ?? '平台请求失败');
    }
    return data as T;
  }

  private attemptHeaders(lease: WorkerLease): HeadersInit {
    return { 'x-attempt-id': lease.attempt_id };
  }

  /** 领取一个匹配当前 Worker 凭据的任务；无任务时返回 null。 */
  async lease(): Promise<WorkerLease | null> {
    return this.request<WorkerLease | null>('/v1/worker/leases', { method: 'POST' });
  }

  async heartbeat(lease: WorkerLease): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/heartbeat`, {
      method: 'POST', headers: this.attemptHeaders(lease),
    });
  }

  async progress(lease: WorkerLease, percent: number, message: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/progress`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ progress: percent, message }),
    });
  }

  /** 写入可分页读取的任务日志；不要在消息中放入凭据或敏感输入。 */
  async log(lease: WorkerLease, level: 'debug' | 'info' | 'warn' | 'error', message: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/logs`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ level, message }),
    });
  }

  stepValue<T>(lease: WorkerLease, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(lease.steps, key) ? lease.steps[key] as T : undefined;
  }

  /** 平台确认保存后才更新本地步骤缓存。 */
  async saveStep(lease: WorkerLease, key: string, value: unknown): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/steps`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ step_key: key, value }),
    });
    lease.steps[key] = value;
  }

  async uploadTextArtifact(lease: WorkerLease, name: string, content: string): Promise<string> {
    const response = await this.request<{ artifact_id: string }>(
      `/v1/worker/tasks/${lease.task_id}/artifacts?name=${encodeURIComponent(name)}`, {
        method: 'PUT', headers: this.attemptHeaders(lease), body: Buffer.from(content, 'utf8'),
      });
    return response.artifact_id;
  }

  async complete(lease: WorkerLease, artifactId: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/complete`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ artifact_id: artifactId }),
    });
  }

  /** 提交经过任务输出 schema 校验的 JSON 结果，可不生成文件产物。 */
  async completeWithOutput(lease: WorkerLease, output: unknown): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/complete`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ output }),
    });
  }

  async fail(lease: WorkerLease, message: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/fail`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ message }),
    });
  }

  /** 执行处理器时持续续租；心跳失败会中止处理器并交由平台恢复。 */
  async withHeartbeat<T>(lease: WorkerLease, work: (client: WorkerClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.options.signal?.reason);
    if (this.options.signal?.aborted) onAbort();
    else this.options.signal?.addEventListener('abort', onAbort, { once: true });
    const client = new WorkerClient({ ...this.options, signal: controller.signal });
    const heartbeat = setInterval(() => {
      void client.heartbeat(lease).catch((error) => controller.abort(error));
    }, this.options.heartbeatMs ?? 15_000);
    try {
      return await work(client, controller.signal);
    } finally {
      clearInterval(heartbeat);
      this.options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
