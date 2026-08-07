import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandDateOnlyIso, isDateOnly, validateTimeZoneFlag } from '../dist/shortcuts/common.js';
import { salesStats } from '../dist/shortcuts/sales/stats.js';

// ---- 纯日期补全(expandDateOnlyIso) ----
test('isDateOnly 只认 YYYY-MM-DD 纯日期', () => {
  assert.equal(isDateOnly('2026-07-01'), true);
  assert.equal(isDateOnly('2026-07-01T00:00:00Z'), false);
  assert.equal(isDateOnly('2026-7-1'), false);
});

test('expandDateOnlyIso 默认 UTC:起=00:00:00Z,止=23:59:59Z', () => {
  assert.equal(expandDateOnlyIso('2026-07-01', false), '2026-07-01T00:00:00Z');
  assert.equal(expandDateOnlyIso('2026-07-01', true), '2026-07-01T23:59:59Z');
});

test('expandDateOnlyIso 非纯日期(已是完整时间戳)原样返回', () => {
  assert.equal(expandDateOnlyIso('2026-07-01T12:34:56Z', false), '2026-07-01T12:34:56Z');
  assert.equal(expandDateOnlyIso('2026-07-01T12:34:56+08:00', true), '2026-07-01T12:34:56+08:00');
});

test('expandDateOnlyIso 按 IANA 时区取偏移(含夏令时)', () => {
  // 洛杉矶 7 月是夏令时 PDT(-07:00),1 月是标准时 PST(-08:00)
  assert.equal(expandDateOnlyIso('2026-07-01', false, 'America/Los_Angeles'), '2026-07-01T00:00:00-07:00');
  assert.equal(expandDateOnlyIso('2026-01-15', true, 'America/Los_Angeles'), '2026-01-15T23:59:59-08:00');
  // 上海无夏令时,恒 +08:00
  assert.equal(expandDateOnlyIso('2026-07-01', false, 'Asia/Shanghai'), '2026-07-01T00:00:00+08:00');
});

// ---- --timezone 校验 ----
test('validateTimeZoneFlag 非法时区名抛类型化 invalid_param;不填跳过', () => {
  assert.throws(
    () => validateTimeZoneFlag({ timezone: 'Not/AZone' }),
    (e) => e?.subtype === 'invalid_timezone' && e?.type === 'invalid_param',
  );
  validateTimeZoneFlag({}); // 未提供不报错
  validateTimeZoneFlag({ timezone: 'America/Los_Angeles' });
  validateTimeZoneFlag({ timezone: 'UTC' });
});

test('sales stats validate 拒绝非法 --timezone', () => {
  assert.throws(
    () => salesStats.validate({ marketplace: 'US', timezone: 'Mars/Olympus' }),
    (e) => e?.subtype === 'invalid_timezone',
  );
});

// ---- 执行:granularityTimeZone 与 interval 补全 ----
function contextWith(flags) {
  const calls = [];
  return {
    calls,
    ctx: {
      flags,
      progress() {},
      client: {
        async get(path, query) {
          calls.push({ path, query });
          return { payload: [] };
        },
      },
    },
  };
}

test('sales stats:--timezone 透传 granularityTimeZone,纯日期 start/end 按该时区补全', async () => {
  const { ctx, calls } = contextWith({
    marketplace: 'US',
    start: '2026-07-01',
    end: '2026-07-03',
    timezone: 'America/Los_Angeles',
  });
  const result = await salesStats.execute(ctx);
  assert.equal(calls[0].query.granularityTimeZone, 'America/Los_Angeles');
  assert.equal(
    calls[0].query.interval,
    '2026-07-01T00:00:00-07:00--2026-07-03T23:59:59-07:00',
  );
  assert.equal(result.timezone, 'America/Los_Angeles');
});

test('sales stats:不填 --timezone 时按 UTC 切日,纯日期补全为 Z 时间戳', async () => {
  const { ctx, calls } = contextWith({
    marketplace: 'US',
    start: '2026-07-01',
    end: '2026-07-03',
  });
  const result = await salesStats.execute(ctx);
  assert.equal(calls[0].query.granularityTimeZone, 'UTC');
  assert.equal(calls[0].query.interval, '2026-07-01T00:00:00Z--2026-07-03T23:59:59Z');
  assert.equal(result.timezone, 'UTC');
});

test('sales stats:完整时间戳输入不做补全,原样传给 API', async () => {
  const { ctx, calls } = contextWith({
    marketplace: 'US',
    start: '2026-07-01T06:00:00Z',
    end: '2026-07-02T06:00:00Z',
  });
  await salesStats.execute(ctx);
  assert.equal(calls[0].query.interval, '2026-07-01T06:00:00Z--2026-07-02T06:00:00Z');
});

// ---- 无时区完整时间的自动补全(最常见的手误:2026-08-06T00:00:00 少了 Z)----

test('有时分秒但无时区的时间自动补上所选时区偏移,不再被 API 拒', async () => {
  const { isIso8601 } = await import('../dist/shortcuts/common.js');
  // 本地校验先要放行(它是合法 ISO 8601 本地时间)
  assert.equal(isIso8601('2026-08-06T00:00:00'), true);
  assert.equal(isIso8601('2026-08-06T00:00'), true);
  assert.equal(isIso8601('2026-08-06T99:00:00'), false, '非法时刻仍要拒');
  // UTC:直接补 Z;缺秒补齐 :00
  assert.equal(expandDateOnlyIso('2026-08-06T00:00:00', false, 'UTC'), '2026-08-06T00:00:00Z');
  assert.equal(expandDateOnlyIso('2026-08-06T09:30', false, 'UTC'), '2026-08-06T09:30:00Z');
  // 指定时区:补该时区当日偏移(柏林 8 月为夏令时 +02:00)
  assert.equal(
    expandDateOnlyIso('2026-08-06T00:00:00', false, 'Europe/Berlin'),
    '2026-08-06T00:00:00+02:00',
  );
  // 已带 Z/偏移的原样不动
  assert.equal(expandDateOnlyIso('2026-08-06T00:00:00Z', false, 'Europe/Berlin'), '2026-08-06T00:00:00Z');
  assert.equal(
    expandDateOnlyIso('2026-08-06T00:00:00+02:00', false, 'UTC'),
    '2026-08-06T00:00:00+02:00',
  );
});

test('sales stats:无时区的 --start/--end 走完整链路后 interval 带偏移', async () => {
  let query;
  const ctx = {
    flags: {
      marketplace: 'DE',
      start: '2026-08-06T00:00:00',
      end: '2026-08-06T23:59:59',
      timezone: 'Europe/Berlin',
      granularity: 'Total',
    },
    progress() {},
    client: {
      async get(_path, q) {
        query = q;
        return { payload: [] };
      },
    },
  };
  salesStats.validate(ctx.flags); // 本地校验放行
  await salesStats.execute(ctx);
  assert.equal(query.interval, '2026-08-06T00:00:00+02:00--2026-08-06T23:59:59+02:00');
});
