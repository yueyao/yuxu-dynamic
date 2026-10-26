/** 应用和任务声明的结构定义及注册前校验，不执行声明中的任务代码。 */
import type { JsonSchema } from './schema.ts';

export type TaskManifest = {
  task_key: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  timeout_ms: number;
  max_attempts: number;
};

export type ApplicationManifest = {
  app_id: string;
  release_digest: string;
  max_concurrency: number;
  tasks: TaskManifest[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSchema(value: unknown, depth = 0): value is JsonSchema {
  if (!record(value) || depth > 8) return false;
  const supported = new Set([
    'type', 'enum', 'required', 'properties', 'additionalProperties', 'items',
    'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems',
  ]);
  if (Object.keys(value).some((key) => !supported.has(key))) return false;
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(value.type))) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 100)) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) ||
    value.required.some((item: unknown) => typeof item !== 'string'))) return false;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return false;
  if (value.properties !== undefined && (!record(value.properties) ||
    Object.values(value.properties).some((child) => !validSchema(child, depth + 1)))) return false;
  if (value.items !== undefined && !validSchema(value.items, depth + 1)) return false;
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string' || value.pattern.length > 100) return false;
    try { new RegExp(value.pattern); } catch { return false; }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return false;
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return false;
  }
  return true;
}

/** 校验部署者提供的声明，避免把无效 schema 存进任务定义。 */
export function parseManifest(value: unknown): ApplicationManifest {
  if (!record(value) || typeof value.app_id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(value.app_id) ||
    typeof value.release_digest !== 'string' || value.release_digest.length > 128 ||
    !/^[a-zA-Z0-9:._-]+$/.test(value.release_digest) ||
    !Number.isSafeInteger(value.max_concurrency) ||
    (value.max_concurrency as number) < 1 || (value.max_concurrency as number) > 100 ||
    !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 100) {
    throw new Error('应用声明的基础字段无效');
  }
  const seen = new Set<string>();
  for (const task of value.tasks) {
    if (!record(task) || typeof task.task_key !== 'string' ||
      !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(task.task_key) ||
      task.task_key.length > 100 || seen.has(task.task_key) ||
      !validSchema(task.input_schema) || !validSchema(task.output_schema) ||
      !Number.isSafeInteger(task.timeout_ms) ||
      (task.timeout_ms as number) < 1_000 || (task.timeout_ms as number) > 86_400_000 ||
      !Number.isSafeInteger(task.max_attempts) ||
      (task.max_attempts as number) < 1 || (task.max_attempts as number) > 10) {
      throw new Error('任务声明无效或任务键重复');
    }
    seen.add(task.task_key);
  }
  return value as ApplicationManifest;
}
