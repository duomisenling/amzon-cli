import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  adsReview,
  aggregateAsinCampaigns,
  buildReviewTotals,
  trimCampaign,
} from '../dist/shortcuts/ads/review.js';

test('trimCampaign:只留决策字段,预算从 budget.budget 提出来', () => {
  const trimmed = trimCampaign({
    campaignId: 'c1',
    name: 'Alpha',
    state: 'ENABLED',
    budget: { budget: 10, budgetType: 'DAILY' },
    startDate: '2026-07-01',
    portfolioId: 'p1', // 不该出现在输出里
    extra: { big: 'blob' },
  });
  assert.deepEqual(trimmed, {
    campaignId: 'c1',
    name: 'Alpha',
    state: 'ENABLED',
    dailyBudget: 10,
    startDate: '2026-07-01',
  });
});

test('aggregateAsinCampaigns:只留目标 ASIN(大小写不敏感),按活动汇总、花费降序', () => {
  const rows = [
    { date: '2026-08-01', campaignId: 'c1', advertisedAsin: 'b0testasin', clicks: 5, cost: 2, purchases7d: 0, sales7d: 0, impressions: 100 },
    { date: '2026-08-02', campaignId: 'c1', advertisedAsin: 'B0TESTASIN', clicks: 5, cost: 2, purchases7d: 1, sales7d: 20, impressions: 100 },
    { date: '2026-08-01', campaignId: 'c2', advertisedAsin: 'B0TESTASIN', clicks: 20, cost: 9, purchases7d: 0, sales7d: 0, impressions: 300 },
    { date: '2026-08-01', campaignId: 'c3', advertisedAsin: 'B000OTHER1', clicks: 50, cost: 30, purchases7d: 5, sales7d: 100, impressions: 900 },
  ];
  const out = aggregateAsinCampaigns(rows, 'B0TESTASIN');
  assert.deepEqual(out, [
    { campaignId: 'c2', impressions: 300, clicks: 20, cost: 9, orders: 0, sales: 0 },
    { campaignId: 'c1', impressions: 200, clicks: 10, cost: 4, orders: 1, sales: 20 },
  ]);
});

test('buildReviewTotals:账户级合计与整体 ACOS/烧钱活动数', () => {
  const totals = buildReviewTotals([
    { cost: 10, sales: 40, orders: 2, clicks: 20, impressions: 100, spendNoSales: false },
    { cost: 5, sales: 0, orders: 0, clicks: 10, impressions: 50, spendNoSales: true },
  ]);
  assert.deepEqual(totals, {
    totalSpend: 15,
    totalSales: 40,
    totalOrders: 2,
    totalClicks: 30,
    overallAcos: 37.5,
    spendNoSalesCount: 1,
  });
});

test('ads review:非法 --asin 本地拦下,合法范围通过', () => {
  assert.throws(
    () => adsReview.validate({ profileId: '123', start: '2026-08-01', end: '2026-08-10', asin: 'not-asin' }),
    (err) => err?.subtype === 'ads.invalid_asin',
  );
});

test('ads review 集成:活动清单+两张报表并行取齐,--asin 时第三张报表过滤聚焦', async () => {
  // 本地服务器按报表类型出对应的 gzip JSON 行
  const reportRows = {
    'r-spCampaigns': [
      { date: '2026-08-01', campaignId: 'c1', campaignName: 'Alpha', impressions: 100, clicks: 10, cost: 5, purchases7d: 0, sales7d: 0 },
      { date: '2026-08-01', campaignId: 'c2', campaignName: 'Beta', impressions: 200, clicks: 20, cost: 3, purchases7d: 2, sales7d: 30 },
    ],
    'r-spSearchTerm': [
      { date: '2026-08-01', campaignId: 'c1', adGroupId: 'g1', searchTerm: 'bad term', clicks: 12, cost: 6, purchases7d: 0 },
      { date: '2026-08-01', campaignId: 'c2', adGroupId: 'g2', searchTerm: 'meh term', clicks: 15, cost: 2, purchases7d: 0 },
    ],
    'r-spAdvertisedProduct': [
      { date: '2026-08-01', campaignId: 'c1', adGroupId: 'g1', advertisedAsin: 'B0TESTASIN', impressions: 100, clicks: 10, cost: 5, purchases7d: 0, sales7d: 0 },
    ],
  };
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(gzipSync(JSON.stringify(reportRows[req.url.slice(1)] ?? [])));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const createdTypes = [];
  const ctx = {
    flags: { profileId: '123', start: '2026-07-21', end: '2026-08-19', asin: 'B0TESTASIN' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') {
          return {
            campaigns: [
              { campaignId: 'c1', name: 'Alpha', state: 'ENABLED', budget: { budget: 10 } },
              { campaignId: 'c2', name: 'Beta', state: 'PAUSED', budget: { budget: 5 } },
            ],
          };
        }
        if (method === 'POST' && path === '/reporting/reports') {
          const type = opts.body.configuration.reportTypeId;
          createdTypes.push(type);
          return { reportId: `r-${type}` };
        }
        const id = path.split('/').pop();
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${id}` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    // 三张报表都建了(并行),活动清单取齐
    assert.deepEqual(createdTypes.sort(), ['spAdvertisedProduct', 'spCampaigns', 'spSearchTerm']);
    assert.equal(result.campaigns.total, 2);
    assert.equal(result.campaigns.enabled, 1);
    assert.equal(result.campaigns.paused, 1);
    // 绩效:烧钱零销售的 c1 排最前
    assert.equal(result.performance[0].campaignId, 'c1');
    assert.equal(result.performance[0].spendNoSales, true);
    assert.deepEqual(result.totals, {
      totalSpend: 8,
      totalSales: 30,
      totalOrders: 2,
      totalClicks: 30,
      overallAcos: 26.7,
      spendNoSalesCount: 1,
    });
    // 废词:两个词都点击≥10 且 0 转化,按花费降序
    assert.deepEqual(result.wastedTerms.map((t) => t.searchTerm), ['bad term', 'meh term']);
    // ASIN 聚焦:只有 c1 在投这个 ASIN,过滤视图只剩 c1 的行
    assert.equal(result.asinFocus.campaignCount, 1);
    assert.deepEqual(result.asinFocus.byCampaign.map((a) => a.campaignId), ['c1']);
    assert.deepEqual(result.asinFocus.performance.map((r) => r.campaignId), ['c1']);
    assert.deepEqual(result.asinFocus.wastedTerms.map((t) => t.searchTerm), ['bad term']);
  } finally {
    server.close();
  }
});

test('ads review 集成:不带 --asin 时只建两张报表,无 asinFocus', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(gzipSync(JSON.stringify([])));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const createdTypes = [];
  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') return { campaigns: [] };
        if (method === 'POST' && path === '/reporting/reports') {
          createdTypes.push(opts.body.configuration.reportTypeId);
          return { reportId: `r-${createdTypes.length}` };
        }
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/empty` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    assert.deepEqual(createdTypes.sort(), ['spCampaigns', 'spSearchTerm']);
    assert.equal(result.asinFocus, undefined);
    assert.equal(result.campaigns.total, 0);
    assert.deepEqual(result.performance, []);
    assert.deepEqual(result.wastedTerms, []);
  } finally {
    server.close();
  }
});
