import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  ADS_REPORT_MAX_DAYS,
  ADS_REPORT_RETENTION_DAYS,
  splitDateRange,
  validateReportWindow,
} from '../dist/shortcuts/ads/common.js';
import { AmzError } from '../dist/internal/errs/errors.js';
import { extractDuplicateReportId, fetchAdsReportRows } from '../dist/shortcuts/ads/report.js';

// 固定"今天"为 2026-08-15,校验逻辑与真实时钟解耦
const TODAY = Date.parse('2026-08-15T10:30:00.000Z');

test('splitDateRange:31 天以内不分段,原样一段', () => {
  assert.deepEqual(splitDateRange('2026-08-01', '2026-08-15'), [
    { start: '2026-08-01', end: '2026-08-15' },
  ]);
  // 正好 31 天也是一段
  assert.deepEqual(splitDateRange('2026-07-16', '2026-08-15'), [
    { start: '2026-07-16', end: '2026-08-15' },
  ]);
  // 同一天(start=end)
  assert.deepEqual(splitDateRange('2026-08-15', '2026-08-15'), [
    { start: '2026-08-15', end: '2026-08-15' },
  ]);
});

test('splitDateRange:32 天切成 31+1,段间无缝无重叠', () => {
  assert.deepEqual(splitDateRange('2026-07-15', '2026-08-15'), [
    { start: '2026-07-15', end: '2026-08-14' },
    { start: '2026-08-15', end: '2026-08-15' },
  ]);
});

test('splitDateRange:95 天切 4 段(31+31+31+2),首尾覆盖完整、跨月边界正确', () => {
  const segs = splitDateRange('2026-05-13', '2026-08-15');
  assert.deepEqual(segs, [
    { start: '2026-05-13', end: '2026-06-12' },
    { start: '2026-06-13', end: '2026-07-13' },
    { start: '2026-07-14', end: '2026-08-13' },
    { start: '2026-08-14', end: '2026-08-15' },
  ]);
  // 相邻段首尾相接:后一段 start = 前一段 end 的次日
  for (let i = 1; i < segs.length; i++) {
    const prevEndNext = new Date(Date.parse(`${segs[i - 1].end}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(segs[i].start, prevEndNext);
  }
});

test('validateReportWindow:正常范围通过(含 95 天上限内的长区间)', () => {
  validateReportWindow({ start: '2026-05-13', end: '2026-08-15' }, { todayMs: TODAY });
  // end 为"明天"也放行(店铺时区可能快于 UTC)
  validateReportWindow({ start: '2026-08-15', end: '2026-08-16' }, { todayMs: TODAY });
});

test('validateReportWindow:--start 早于 95 天留存期被拦,提示最早可用日期', () => {
  assert.throws(
    () => validateReportWindow({ start: '2026-05-12', end: '2026-08-15' }, { todayMs: TODAY }),
    (err) => err.subtype === 'ads.report_window_too_old' && err.hintHuman.includes('2026-05-13'),
  );
});

test('validateReportWindow:--end 在未来(超 1 天余量)被拦', () => {
  assert.throws(
    () => validateReportWindow({ start: '2026-08-01', end: '2026-08-17' }, { todayMs: TODAY }),
    (err) => err.subtype === 'ads.report_window_future',
  );
});

test('validateReportWindow:传 maxDays 时跨度超限被拦,提示分段或换自动分段命令', () => {
  assert.throws(
    () =>
      validateReportWindow(
        { start: '2026-07-01', end: '2026-08-10' },
        { maxDays: ADS_REPORT_MAX_DAYS, todayMs: TODAY },
      ),
    (err) =>
      err.subtype === 'ads.report_window_too_long' &&
      err.hintHuman.includes('41 天') &&
      err.hintHuman.includes('wasted-spend'),
  );
  // 不传 maxDays(自动分段的命令)同样的跨度直接通过
  validateReportWindow({ start: '2026-07-01', end: '2026-08-10' }, { todayMs: TODAY });
});

test('常量口径:31 天单张上限 / 95 天留存期', () => {
  assert.equal(ADS_REPORT_MAX_DAYS, 31);
  assert.equal(ADS_REPORT_RETENTION_DAYS, 95);
});

test('extractDuplicateReportId:从真实 425 响应文本里抠出原报表 ID', () => {
  // 真实事故的 message 形态(ads-client 会把响应正文拼进 message)
  const msg =
    'Ads API HTTP 425 on /reporting/reports: {"code":"425","detail":"The Request is a duplicate of : dc0dd969-3eb3-4067-b1ff-d36631b07eb5"}';
  assert.equal(extractDuplicateReportId(msg), 'dc0dd969-3eb3-4067-b1ff-d36631b07eb5');
  assert.equal(extractDuplicateReportId('no uuid here'), undefined);
});

test('fetchAdsReportRows:创建撞 425 重复时自动复用原报表,不报错', async () => {
  const dupId = 'dc0dd969-3eb3-4067-b1ff-d36631b07eb5';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(gzipSync(JSON.stringify([{ searchTerm: 'reused' }])));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const polled = [];
  const ctx = {
    flags: {},
    progress() {},
    adsClient: {
      async request(method, path) {
        if (method === 'POST') {
          throw new AmzError({
            type: 'upstream_error',
            subtype: 'ads.duplicate_request',
            hintAgent: 'fix_param',
            hintHuman: '重复请求',
            message: `Ads API HTTP 425 on /reporting/reports: {"code":"425","detail":"The Request is a duplicate of : ${dupId}"}`,
            status: 425,
          });
        }
        polled.push(path);
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/x` };
      },
    },
  };

  try {
    const rows = await fetchAdsReportRows(
      ctx,
      '123',
      {
        reportTypeId: 'spSearchTerm',
        groupBy: ['searchTerm'],
        columns: ['date', 'searchTerm'],
        start: '2026-07-21',
        end: '2026-08-19',
      },
      1,
    );
    assert.deepEqual(rows, [{ searchTerm: 'reused' }]);
    // 轮询的正是 425 响应里给的原报表 ID
    assert.equal(polled[0], `/reporting/reports/${dupId}`);
  } finally {
    server.close();
  }
});

test('fetchAdsReportRows:跨度 32 天自动分 2 段,每段一张报表,行按段拼接', async () => {
  // 本地服务器充当报表下载地址:按路径 /r1 /r2 返回各段的 gzip JSON 行
  const server = createServer((req, res) => {
    const seg = req.url === '/r1' ? 1 : 2;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(gzipSync(JSON.stringify([{ seg, searchTerm: `term-${seg}` }])));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const created = []; // 每次 createReport 的 {startDate, endDate}
  const ctx = {
    flags: {},
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (method === 'POST' && path === '/reporting/reports') {
          created.push({ startDate: opts.body.startDate, endDate: opts.body.endDate });
          return { reportId: `r${created.length}` };
        }
        // 轮询:立即 COMPLETED,下载地址指向本地服务器
        const id = path.split('/').pop();
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${id}` };
      },
    },
  };

  try {
    const rows = await fetchAdsReportRows(
      ctx,
      '123',
      {
        reportTypeId: 'spSearchTerm',
        groupBy: ['searchTerm'],
        columns: ['date', 'searchTerm'],
        start: '2026-07-15',
        end: '2026-08-15',
      },
      1,
    );
    assert.deepEqual(created, [
      { startDate: '2026-07-15', endDate: '2026-08-14' },
      { startDate: '2026-08-15', endDate: '2026-08-15' },
    ]);
    assert.deepEqual(rows, [
      { seg: 1, searchTerm: 'term-1' },
      { seg: 2, searchTerm: 'term-2' },
    ]);
  } finally {
    server.close();
  }
});
