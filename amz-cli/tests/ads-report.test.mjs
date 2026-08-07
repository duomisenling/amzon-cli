import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsConfigFromFlags, adsReportStatus } from '../dist/shortcuts/ads/report.js';

const dates = { start: '2026-07-01', end: '2026-07-07' };

test('adsConfigFromFlags:--columns/--group-by 空项被过滤,不把空字符串传给 API', () => {
  const cfg = adsConfigFromFlags({
    flags: { ...dates, columns: 'date,,cost, ,clicks', groupBy: ' campaign,, adGroup ,' },
  });
  assert.deepEqual(cfg.columns, ['date', 'cost', 'clicks']);
  assert.deepEqual(cfg.groupBy, ['campaign', 'adGroup']);
});

test('adsConfigFromFlags:不传 columns/group-by 时用预设值', () => {
  const cfg = adsConfigFromFlags({ flags: { ...dates, type: 'search-terms' } });
  assert.equal(cfg.reportTypeId, 'spSearchTerm');
  assert.deepEqual(cfg.groupBy, ['searchTerm']);
  assert.equal(cfg.columns.includes('searchTerm'), true);
  assert.equal(cfg.columns.some((c) => c === ''), false);
});

test('report-status:--report-id 空串/缺失时抛类型化参数错误,不拼 /reports/undefined', async () => {
  // validate 阶段就拦下
  assert.throws(
    () => adsReportStatus.validate({ profileId: '123', reportId: '' }),
    (error) => error?.subtype === 'ads.missing_report_id',
  );
  // execute 阶段同样拦下(防绕过 validate 的调用路径)
  let requested = false;
  const ctx = {
    flags: { profileId: '123', reportId: '   ' },
    progress() {},
    adsClient: {
      async request() {
        requested = true;
        return {};
      },
    },
  };
  await assert.rejects(
    adsReportStatus.execute(ctx),
    (error) => error?.subtype === 'ads.missing_report_id',
  );
  assert.equal(requested, false);
});

test('report-status:合法 report-id 原样进 URL', async () => {
  let requestedPath;
  const ctx = {
    flags: { profileId: '123', reportId: 'rep-001' },
    progress() {},
    adsClient: {
      async request(method, path) {
        requestedPath = path;
        return { reportId: 'rep-001', status: 'PENDING' };
      },
    },
  };
  const result = await adsReportStatus.execute(ctx);
  assert.equal(requestedPath, '/reporting/reports/rep-001');
  assert.equal(result.status, 'PENDING');
});
