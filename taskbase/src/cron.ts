/** 5 字段 cron 解析与下一次触发计算；支持标准 *、列表、区间、步长。 */

export type ParsedCron = {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_INDEX: Record<string, number> = Object.fromEntries(
  WEEKDAY_NAMES.map((name, index) => [name, index]),
);

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function validateTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function localParts(epochMs: number, timezone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const weekday = WEEKDAY_INDEX[values.weekday];
  if (weekday === undefined) throw new Error('无法解析本地星期');
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    weekday,
  };
}

function parseNumber(value: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} 字段包含非法值：${value}`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  return parsed;
}

function parseField(field: string, label: string, min: number, max: number,
  options: { sundayAlias?: boolean } = {}): Set<number> {
  const values = new Set<number>();
  const add = (value: number) => {
    const normalized = options.sundayAlias && value === 7 ? 0 : value;
    if (normalized < min || normalized > max) throw new Error(`${label} 超出范围`);
    values.add(normalized);
  };
  for (const segment of field.split(',')) {
    if (segment.length === 0) throw new Error(`${label} 字段为空`);
    const [rangePart, stepPart, extra] = segment.split('/');
    if (extra !== undefined || (stepPart !== undefined && !/^\d+$/.test(stepPart))) {
      throw new Error(`${label} 字段步长无效`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error(`${label} 字段步长无效`);
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = options.sundayAlias ? 0 : min;
      end = options.sundayAlias ? 6 : max;
    } else if (rangePart.includes('-')) {
      const [from, to, more] = rangePart.split('-');
      if (more !== undefined) throw new Error(`${label} 字段区间无效`);
      const parseMax = options.sundayAlias ? 7 : max;
      start = parseNumber(from, label, min, parseMax);
      end = parseNumber(to, label, min, parseMax);
      if (start > end) throw new Error(`${label} 字段区间起点大于终点`);
    } else {
      start = parseNumber(rangePart, label, min, options.sundayAlias ? 7 : max);
      end = stepPart === undefined ? start : (options.sundayAlias ? 6 : max);
    }
    for (let value = start; value <= end; value += step) add(value);
  }
  if (values.size === 0) throw new Error(`${label} 字段没有有效值`);
  return values;
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 必须是 5 个字段：分 时 日 月 周');
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  return {
    expression: expression.trim(),
    minutes: parseField(minuteField, '分钟', 0, 59),
    hours: parseField(hourField, '小时', 0, 23),
    days: parseField(dayField, '日期', 1, 31),
    months: parseField(monthField, '月份', 1, 12),
    weekdays: parseField(weekdayField, '星期', 0, 6, { sundayAlias: true }),
    domRestricted: dayField !== '*',
    dowRestricted: weekdayField !== '*',
  };
}

function matches(cron: ParsedCron, parts: LocalParts): boolean {
  if (!cron.months.has(parts.month) || !cron.hours.has(parts.hour) || !cron.minutes.has(parts.minute)) {
    return false;
  }
  const dom = cron.days.has(parts.day);
  const dow = cron.weekdays.has(parts.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

/** 返回严格晚于 afterMs 的下一次触发时间；最多向后扫描 366 天。 */
export function nextFire(expression: string, timezone: string, afterMs: number): number | null {
  const cron = parseCron(expression);
  if (!validateTimezone(timezone)) throw new Error('时区无效');
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const limit = 366 * 24 * 60;
  for (let index = 0; index < limit; index += 1) {
    if (matches(cron, localParts(candidate, timezone))) return candidate;
    candidate += 60_000;
  }
  return null;
}
