import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextFire } from '../src/cron.ts';

test('cron：跨闰年与不可能的日期，无逐分钟长扫描', () => {
  const started = performance.now();
  const next = nextFire('0 0 29 2 *', 'Asia/Shanghai', Date.parse('2026-11-08T00:00:00Z'));
  assert.equal(new Date(next!).toISOString(), '2028-02-28T16:00:00.000Z');
  assert.equal(nextFire('0 0 31 2 *', 'UTC', Date.parse('2026-11-08T00:00:00Z')), null);
  assert.ok(performance.now() - started < 500);
});

test('cron：DST 春季跳过不存在的时间，秋季两个重复时间均可触发', () => {
  assert.equal(new Date(nextFire('30 2 * * *', 'America/New_York', Date.parse('2026-03-08T05:00:00Z'))!).toISOString(),
    '2026-03-09T06:30:00.000Z');
  assert.equal(new Date(nextFire('30 1 * * *', 'America/New_York', Date.parse('2026-11-01T05:30:00Z'))!).toISOString(),
    '2026-11-01T06:30:00.000Z');
  assert.equal(new Date(nextFire('0 1 * * *', 'America/New_York', Date.parse('2026-11-01T05:45:00Z'))!).toISOString(),
    '2026-11-01T06:00:00.000Z');
});

test('cron：步长、半小时偏移和日期/星期组合', () => {
  const after = Date.parse('2026-11-08T00:01:00Z');
  assert.equal(nextFire('*/5 * * * *', 'Asia/Kolkata', after), Date.parse('2026-11-08T00:05:00Z'));
  assert.equal(nextFire('0 9 */1 * 1', 'UTC', after), Date.parse('2026-11-09T09:00:00Z'));
  assert.equal(nextFire('0 9 10 * 1', 'UTC', after), Date.parse('2026-11-09T09:00:00Z'));
});
