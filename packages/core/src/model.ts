/** 示例应用常量、任务状态类型和提交输入的稳定序列化规则。 */
export const exampleApp = {
  appId: 'example-app',
  releaseDigest: 'mvp-v1',
  taskKey: 'report/build',
  timeoutMs: 60 * 60 * 1000,
  maxAttempts: 3,
  maxConcurrency: 4,
  inputSchema: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['artifact_id'],
    additionalProperties: false,
    properties: {
      artifact_id: { type: 'string', minLength: 1 },
    },
  },
} as const;

export type TaskStatus = 'queued' | 'running' | 'recovering' | 'succeeded' | 'failed';

/** 稳定排序对象键，供同一幂等键下的输入摘要比较使用。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // 固定按字符码点排序，避免不同系统区域设置产生不同的幂等摘要。
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
