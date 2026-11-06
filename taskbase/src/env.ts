/** YUXUN_* 优先，迁移期回退旧 TASKBASE_*。 */
export function envValue(name: string, legacy: string, fallback?: string): string | undefined {
  return process.env[name] ?? process.env[legacy] ?? fallback;
}
