/**
 * 应用后端和 CLI 共用的用户侧 HTTP 客户端。
 * 调用方提供用户 Token；浏览器页面不能使用 Worker Token。
 */
export type TaskStatus = 'queued' | 'running' | 'recovering' | 'succeeded' | 'failed';

export type Task = {
  task_id: string;
  app_id: string;
  task_key: string;
  release_digest: string;
  status: TaskStatus;
  progress: number;
  created_at: string;
  scheduled_at: string | null;
  updated_at: string;
  deadline_at: string;
  attempt_count: number;
  output: unknown | null;
  artifact_id: string | null;
  error: string | null;
};

export type TaskResult = Pick<Task, 'task_id' | 'status' | 'output' | 'artifact_id' | 'error'>;
export type TaskLog = { id: number; attempt_id: string | null; level: string; message: string; created_at: string };

export class PlatformError extends Error {
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

export class PlatformClient {
  private readonly options: {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  };

  constructor(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number }) {
    this.options = options;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetchImpl ?? fetch)(new URL(path, this.options.baseUrl), {
      ...init,
      headers: { authorization: `Bearer ${this.options.token}`,
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { code?: string; message?: string; request_id?: string } | undefined;
      throw new PlatformError(response.status, error?.code ?? 'REMOTE_ERROR',
        error?.message ?? '平台请求失败', error?.request_id);
    }
    return data as T;
  }

  listApps(): Promise<{ apps: Array<{ app_id: string; release_digest: string }> }> {
    return this.request('/v1/apps');
  }

  listDefinitions(appId: string): Promise<{ tasks: unknown[] }> {
    return this.request(`/v1/apps/${encodeURIComponent(appId)}/tasks`);
  }

  /** runAt 是带时区的 ISO 8601 时间；缺省时立即入队。 */
  submitTask(task: string, input: unknown, options: { runAt?: string; idempotencyKey?: string } = {}) {
    return this.request<{ task: Task; reused: boolean }>('/v1/tasks', {
      method: 'POST',
      headers: options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {},
      body: JSON.stringify({ task, input, ...(options.runAt ? { run_at: options.runAt } : {}) }),
    });
  }

  listTasks(filters: { appId?: string; taskKey?: string; status?: TaskStatus; limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams();
    if (filters.appId) query.set('app_id', filters.appId);
    if (filters.taskKey) query.set('task_key', filters.taskKey);
    if (filters.status) query.set('status', filters.status);
    if (filters.limit !== undefined) query.set('limit', String(filters.limit));
    if (filters.cursor) query.set('cursor', filters.cursor);
    return this.request<{ tasks: Task[]; next_cursor: string | null }>(`/v1/tasks?${query}`);
  }

  getTask(taskId: string): Promise<Task> {
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  /** 未终结时 HTTP 返回 202，SDK 仍返回包含当前状态的结果对象。 */
  getResult(taskId: string): Promise<TaskResult> {
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/result`);
  }

  getEvents(taskId: string, after = 0): Promise<{ events: Array<{ id: number; type: string; payload: unknown }> }> {
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/events?after=${after}`);
  }

  getLogs(taskId: string, after = 0): Promise<{ logs: TaskLog[] }> {
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/logs?after=${after}`);
  }

  /** 下载成功任务的最终产物字节，调用前从结果中取得 artifact_id。 */
  async downloadArtifact(artifactId: string): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL(`/v1/artifacts/${encodeURIComponent(artifactId)}/download`, this.options.baseUrl), {
        headers: { authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
      });
    if (!response.ok) {
      const body = await response.json() as { error?: { code?: string; message?: string; request_id?: string } };
      throw new PlatformError(response.status, body.error?.code ?? 'REMOTE_ERROR',
        body.error?.message ?? '产物下载失败', body.error?.request_id);
    }
    return { data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
