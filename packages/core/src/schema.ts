/** 受控 JSON Schema 子集的类型和递归校验器。 */
import { canonicalJson } from './model.ts';

/** 本地 MVP 支持的 JSON Schema 子集；任务声明只包含数据。 */
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

/** 只解释受支持的声明字段，不执行任务声明中的代码。 */
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
      // pattern 来自受信任的部署声明，不能由任务提交者传入。
      if (rule.pattern && !new RegExp(rule.pattern).test(current)) {
        issues.push({ path, message: '格式不符合要求' });
      }
    }
    if (typeof current === 'number') {
      if (rule.minimum !== undefined && current < rule.minimum) issues.push({ path, message: `不能小于 ${rule.minimum}` });
      if (rule.maximum !== undefined && current > rule.maximum) issues.push({ path, message: `不能大于 ${rule.maximum}` });
    }
    if (Array.isArray(current)) {
      if (rule.minItems !== undefined && current.length < rule.minItems) issues.push({ path, message: `元素不能少于 ${rule.minItems} 个` });
      if (rule.maxItems !== undefined && current.length > rule.maxItems) issues.push({ path, message: `元素不能超过 ${rule.maxItems} 个` });
      if (rule.items) current.forEach((item, index) => visit(rule.items as JsonSchema, item, `${path}[${index}]`));
    }
    if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
      const object = current as Record<string, unknown>;
      for (const key of rule.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) issues.push({ path: `${path}.${key}`, message: '此字段必填' });
      }
      for (const [key, item] of Object.entries(object)) {
        const child = rule.properties?.[key];
        if (child) visit(child, item, `${path}.${key}`);
        else if (rule.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: '不允许此字段' });
      }
    }
  }

  visit(schema, value, '$');
  return issues;
}
