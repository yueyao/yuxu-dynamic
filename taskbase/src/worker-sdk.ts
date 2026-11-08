/** Worker 侧的最小 HTTP 客户端：领取、心跳、进度、日志、检查点、产物、完成和失败。 */

export type WorkerLease = {
  task_id: string;
  attempt_id: string;
  app_id: string;
  task_key: string;
  input: unknown;
  steps: Record<string, unknown>;
  deadline_at: string;
  schedule_id: string | null;
  planned_fire_time: string | null;
};

export type WorkerClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
};

export class RemoteError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(requestId ? `${message} (request_id: ${requestId})` : message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('已中止'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('已中止'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class WorkerClient {
  private readonly options: WorkerClientOptions;

  constructor(options: WorkerClientOptions) {
    this.options = options;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const response = await (this.options.fetchImpl ?? fetch)(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.options.requestTimeoutMs ?? 30_000),
    });
    if (response.status === 204) return null as T;
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { code?: string; message?: string; request_id?: string } | undefined;
      throw new RemoteError(response.status, error?.code ?? 'REMOTE_ERROR',
        error?.message ?? '平台请求失败', error?.request_id);
    }
    return data as T;
  }

  private attemptHeaders(lease: WorkerLease): Record<string, string> {
    return { 'x-attempt-id': lease.attempt_id };
  }

  lease(): Promise<WorkerLease | null> {
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
    }, 60_000);
  }

  async log(lease: WorkerLease, level: 'debug' | 'info' | 'warn' | 'error', message: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/logs`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ level, message }),
    }, 60_000);
  }

  stepValue<T>(lease: WorkerLease, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(lease.steps, key) ? lease.steps[key] as T : undefined;
  }

  async saveStep(lease: WorkerLease, key: string, value: unknown): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/steps`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ step_key: key, value }),
    }, 120_000);
    lease.steps[key] = value;
  }

  async uploadArtifact(lease: WorkerLease, name: string, data: Uint8Array | Buffer,
    contentType = 'application/octet-stream'): Promise<string> {
    const response = await this.request<{ artifact_id: string }>(
      `/v1/worker/tasks/${lease.task_id}/artifacts?name=${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { ...this.attemptHeaders(lease), 'content-type': contentType },
        body: data as BodyInit,
      }, 120_000);
    return response.artifact_id;
  }

  async complete(lease: WorkerLease, output: unknown): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/complete`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ output }),
    }, 180_000);
  }

  async fail(lease: WorkerLease, message: string): Promise<void> {
    await this.request(`/v1/worker/tasks/${lease.task_id}/fail`, {
      method: 'POST', headers: this.attemptHeaders(lease),
      body: JSON.stringify({ message }),
    });
  }

  /** 执行处理器期间持续续租；心跳失败会中止工作。 */
  async withHeartbeat<T>(lease: WorkerLease,
    work: (client: WorkerClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.heartbeat(lease).catch((error) => controller.abort(error));
    }, this.options.heartbeatMs ?? 15_000);
    try {
      return await work(this, controller.signal);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
