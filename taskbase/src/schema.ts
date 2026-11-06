/** 受控 JSON Schema 子集：任务输入/输出校验，不执行声明中的代码。 */

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type SchemaIssue = { path: string; message: string };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function matchesType(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
  }
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  function visit(rule: JsonSchema, current: unknown, path: string): void {
    if (rule.type && !matchesType(current, rule.type)) {
      issues.push({ path, message: `必须是 ${rule.type}` });
      return;
    }
    if (rule.enum && !rule.enum.some((entry) => canonicalJson(entry) === canonicalJson(current))) {
      issues.push({ path, message: '值不在允许范围内' });
    }
    if (typeof current === 'string') {
      if (rule.minLength !== undefined && current.length < rule.minLength) {
        issues.push({ path, message: `长度不能少于 ${rule.minLength}` });
      }
      if (rule.maxLength !== undefined && current.length > rule.maxLength) {
        issues.push({ path, message: `长度不能超过 ${rule.maxLength}` });
      }
      if (rule.pattern) {
        try {
          if (!new RegExp(rule.pattern).test(current)) issues.push({ path, message: '格式不符合要求' });
        } catch {
          issues.push({ path, message: 'schema 正则无效' });
        }
      }
    }
    if (typeof current === 'number') {
      if (rule.minimum !== undefined && current < rule.minimum) {
        issues.push({ path, message: `不能小于 ${rule.minimum}` });
      }
      if (rule.maximum !== undefined && current > rule.maximum) {
        issues.push({ path, message: `不能大于 ${rule.maximum}` });
      }
    }
    if (Array.isArray(current)) {
      if (rule.minItems !== undefined && current.length < rule.minItems) {
        issues.push({ path, message: `元素不能少于 ${rule.minItems} 个` });
      }
      if (rule.maxItems !== undefined && current.length > rule.maxItems) {
        issues.push({ path, message: `元素不能超过 ${rule.maxItems} 个` });
      }
      if (rule.items) {
        current.forEach((item, index) => visit(rule.items as JsonSchema, item, `${path}[${index}]`));
      }
    }
    if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      for (const key of rule.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) {
          issues.push({ path: `${path}.${key}`, message: '此字段必填' });
        }
      }
      for (const [key, item] of Object.entries(object)) {
        const child = rule.properties?.[key];
        if (child) visit(child, item, `${path}.${key}`);
        else if (rule.additionalProperties === false) {
          issues.push({ path: `${path}.${key}`, message: '不允许此字段' });
        }
      }
    }
  }

  visit(schema, value, '$');
  return issues;
}

export type TaskManifest = {
  task_key: string;
  display_name: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  queue_timeout_ms: number;
  execution_timeout_ms: number;
  max_attempts: number;
  artifact_policy: { required: boolean; max_bytes?: number };
  schedulable: boolean;
};

export type AppManifest = {
  app_id: string;
  display_name: string;
  max_concurrency: number;
  tasks: TaskManifest[];
};

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SCHEMA_KEYS = new Set([
  'type', 'enum', 'required', 'properties', 'additionalProperties', 'items',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems',
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validSchema(value: unknown, depth = 0): value is JsonSchema {
  if (!record(value) || depth > 8) return false;
  if (Object.keys(value).some((key) => !SCHEMA_KEYS.has(key))) return false;
  if (typeof value.type !== 'string' || !TYPES.has(value.type)) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 100)) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) ||
    value.required.some((item) => typeof item !== 'string'))) return false;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return false;
  if (value.properties !== undefined) {
    if (!record(value.properties)) return false;
    if (Object.values(value.properties).some((child) => !validSchema(child, depth + 1))) return false;
  }
  if (value.items !== undefined && !validSchema(value.items, depth + 1)) return false;
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string' || value.pattern.length > 100) return false;
    try { new RegExp(value.pattern); } catch { return false; }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (value[key] !== undefined && !safeInteger(value[key], 0, 1_000_000)) return false;
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return false;
  }
  return true;
}

export function parseManifest(value: unknown): AppManifest {
  if (!record(value) ||
    typeof value.app_id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value.app_id) ||
    typeof value.display_name !== 'string' || value.display_name.trim().length === 0 ||
    value.display_name.length > 100 ||
    (value.max_concurrency !== undefined && !safeInteger(value.max_concurrency, 1, 20)) ||
    !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 50) {
    throw new Error('应用声明无效：检查 app_id、display_name、max_concurrency 和 tasks');
  }
  const seen = new Set<string>();
  const tasks: TaskManifest[] = [];
  for (const task of value.tasks as unknown[]) {
    if (!record(task) ||
      typeof task.task_key !== 'string' || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(task.task_key) ||
      task.task_key.length > 100 || seen.has(task.task_key) ||
      typeof task.display_name !== 'string' || task.display_name.trim().length === 0 ||
      !validSchema(task.input_schema) || task.input_schema.type !== 'object' ||
      !validSchema(task.output_schema) || task.output_schema.type !== 'object') {
      throw new Error('任务声明无效：检查 task_key、display_name 和 input/output schema');
    }
    const queueTimeout = task.queue_timeout_ms === undefined ? 3_600_000 : task.queue_timeout_ms;
    const executionTimeout = task.execution_timeout_ms === undefined ? 3_600_000 : task.execution_timeout_ms;
    if (!safeInteger(queueTimeout, 1_000, 21_600_000) ||
      !safeInteger(executionTimeout, 1_000, 21_600_000)) {
      throw new Error('任务超时必须在 1 秒到 6 小时之间');
    }
    const maxAttempts = task.max_attempts === undefined ? 3 : task.max_attempts;
    if (!safeInteger(maxAttempts, 1, 10)) throw new Error('max_attempts 必须是 1–10 的整数');
    let artifactPolicy: TaskManifest['artifact_policy'] = { required: false };
    if (task.artifact_policy !== undefined) {
      if (!record(task.artifact_policy) || (task.artifact_policy.required !== undefined &&
        typeof task.artifact_policy.required !== 'boolean')) {
        throw new Error('artifact_policy 无效');
      }
      const maxBytes = task.artifact_policy.max_bytes;
      if (maxBytes !== undefined && !safeInteger(maxBytes, 1, 104_857_600)) {
        throw new Error('artifact_policy.max_bytes 无效');
      }
      artifactPolicy = {
        required: (task.artifact_policy.required as boolean | undefined) ?? false,
        ...(typeof maxBytes === 'number' ? { max_bytes: maxBytes } : {}),
      };
    }
    if (task.schedulable !== undefined && typeof task.schedulable !== 'boolean') {
      throw new Error('schedulable 必须是 boolean');
    }
    seen.add(task.task_key);
    tasks.push({
      task_key: task.task_key,
      display_name: task.display_name,
      input_schema: task.input_schema,
      output_schema: task.output_schema,
      queue_timeout_ms: queueTimeout,
      execution_timeout_ms: executionTimeout,
      max_attempts: maxAttempts,
      artifact_policy: artifactPolicy,
      schedulable: (task.schedulable as boolean | undefined) ?? false,
    });
  }
  return {
    app_id: value.app_id,
    display_name: value.display_name,
    max_concurrency: (value.max_concurrency as number | undefined) ?? 1,
    tasks,
  };
}
