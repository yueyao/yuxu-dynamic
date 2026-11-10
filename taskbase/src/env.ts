/** YUXUN_* 优先，迁移期回退旧 TASKBASE_*。 */
export function envValue(name: string, legacy: string, fallback?: string): string | undefined {
  return process.env[name] ?? process.env[legacy] ?? fallback;
}

export function positiveInt(value: string | number | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}
