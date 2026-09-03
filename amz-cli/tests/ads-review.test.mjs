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

test('ads review:--asin 的广告商品报表失败时,主体数据照常返回,只把 asinFocus 标成失败', async () => {
  // 回归:第三张报表是可选增强,旧实现用裸 Promise.all,它一失败(报表类型不支持/
  // 过期/超时)会把已经拿到的活动清单、绩效、废词一起丢掉——那才是这条命令的主体价值。
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const rows =
      req.url === '/r-spCampaigns'
        ? [{ date: '2026-08-01', campaignId: 'c1', campaignName: 'Alpha', impressions: 100, clicks: 10, cost: 5, purchases7d: 0, sales7d: 0 }]
        : [{ date: '2026-08-01', campaignId: 'c1', adGroupId: 'g1', searchTerm: 'bad term', clicks: 12, cost: 6, purchases7d: 0 }];
    res.end(gzipSync(JSON.stringify(rows)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10', asin: 'B0TESTASIN' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') {
          return { campaigns: [{ campaignId: 'c1', name: 'Alpha', state: 'ENABLED', budget: { budget: 10 } }] };
        }
        if (method === 'POST' && path === '/reporting/reports') {
          const type = opts.body.configuration.reportTypeId;
          // 只让广告商品报表失败,另外两张正常
          if (type === 'spAdvertisedProduct') throw new Error('report type not supported for this account');
          return { reportId: `r-${type}` };
        }
        const id = path.split('/').pop();
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${id}` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    // 主体数据完好
    assert.equal(result.campaigns.total, 1);
    assert.equal(result.performance[0].campaignId, 'c1');
    assert.deepEqual(result.wastedTerms.map((t) => t.searchTerm), ['bad term']);
    // ASIN 聚焦部分明确标注失败原因，而不是静默给空视图
    assert.equal(result.asinFocus.error, 'ads.advertised_product_report_failed');
    assert.equal(result.asinFocus.asin, 'B0TESTASIN');
    assert.match(result.asinFocus.detail, /not supported/);
    assert.equal(result.asinFocus.byCampaign, undefined);
  } finally {
    server.close();
  }
});

test('ads review:--top 截断输出但计数按全量,且 ASIN 聚焦仍从全量里找', async () => {
  // 大账户场景:150 个活动全量返回会撑爆 Agent 上下文,默认只给最差的 100 条。
  // 关键边界:目标 ASIN 的活动排在第 121 位(截断线之外),asinFocus 必须仍能找到它
  // ——如果拿截断后的列表去过滤,这个 ASIN 的聚焦视图会莫名其妙变成空的。
  const N = 150;
  const perfRows = Array.from({ length: N }, (_, i) => ({
    date: '2026-08-01',
    campaignId: `c${i}`,
    campaignName: `Campaign ${i}`,
    impressions: 1000,
    clicks: 50,
    cost: N - i, // cost 递减 → ACOS 递减 → c0 最差排最前
    purchases7d: 1,
    sales7d: 100,
  }));
  const TARGET = 'c120'; // ACOS 第 121 差,落在 top=100 之外

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const rows =
      req.url === '/r-spCampaigns'
        ? perfRows
        : req.url === '/r-spAdvertisedProduct'
          ? [{ date: '2026-08-01', campaignId: TARGET, adGroupId: 'g1', advertisedAsin: 'B0TESTASIN', impressions: 100, clicks: 10, cost: 5, purchases7d: 0, sales7d: 0 }]
          : [{ date: '2026-08-01', campaignId: TARGET, adGroupId: 'g1', searchTerm: 'bad term', clicks: 12, cost: 6, purchases7d: 0 }];
    res.end(gzipSync(JSON.stringify(rows)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10', asin: 'B0TESTASIN' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') {
          return {
            campaigns: Array.from({ length: N }, (_, i) => ({
              campaignId: `c${i}`,
              name: `Campaign ${i}`,
              state: 'ENABLED',
              budget: { budget: 10 },
            })),
          };
        }
        if (method === 'POST' && path === '/reporting/reports') {
          return { reportId: `r-${opts.body.configuration.reportTypeId}` };
        }
        const id = path.split('/').pop();
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${id}` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);

    // 明细截断到默认 100 条，并明确标注
    assert.equal(result.performance.length, 100);
    assert.equal(result.performanceCount, N);
    assert.equal(result.performanceTruncated, true);
    assert.equal(result.campaigns.items.length, 100);
    assert.equal(result.campaigns.itemsTruncated, true);

    // 计数与合计始终按全量算，不受截断影响
    assert.equal(result.campaigns.total, N);
    assert.equal(result.campaigns.enabled, N);
    assert.equal(result.totals.totalSpend, perfRows.reduce((s, r) => s + r.cost, 0));
    assert.equal(result.totals.totalClicks, N * 50);

    // 截断线之外的目标活动，ASIN 聚焦照样找得到
    assert.equal(result.performance.some((r) => r.campaignId === TARGET), false, '前提:目标活动确实被截断了');
    assert.deepEqual(result.asinFocus.byCampaign.map((a) => a.campaignId), [TARGET]);
    assert.deepEqual(result.asinFocus.performance.map((r) => r.campaignId), [TARGET]);
  } finally {
    server.close();
  }
});

test('ads review:--top 可显式调大/调小,不传时不截断小账户', async () => {
  // 日期必须相对"今天"算:validate 会用真实 Date.now() 校验 95 天留存期,
  // 硬编码固定日期的话,过几个月这个测试会突然改报 report_window_too_old(定时炸弹)。
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const recent = { start: iso(10), end: iso(3) };
  assert.throws(
    () => adsReview.validate({ profileId: '123', ...recent, top: '0' }),
    (err) => err?.subtype === 'invalid_number',
  );
  adsReview.validate({ profileId: '123', ...recent, top: '500' });

  // 小账户(2 个活动)不带任何截断标记
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const rows =
      req.url === '/r-spCampaigns'
        ? [
            { date: '2026-08-01', campaignId: 'c1', campaignName: 'A', impressions: 10, clicks: 5, cost: 5, purchases7d: 0, sales7d: 0 },
            { date: '2026-08-01', campaignId: 'c2', campaignName: 'B', impressions: 10, clicks: 5, cost: 3, purchases7d: 1, sales7d: 30 },
          ]
        : [];
    res.end(gzipSync(JSON.stringify(rows)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') {
          return { campaigns: [{ campaignId: 'c1', name: 'A', state: 'ENABLED' }, { campaignId: 'c2', name: 'B', state: 'PAUSED' }] };
        }
        if (method === 'POST' && path === '/reporting/reports') {
          return { reportId: `r-${opts.body.configuration.reportTypeId}` };
        }
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${path.split('/').pop()}` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    assert.equal(result.performance.length, 2);
    assert.equal(result.performanceCount, 2);
    assert.equal(result.performanceTruncated, undefined);
    assert.equal(result.campaigns.itemsTruncated, undefined);
    assert.equal(result.campaigns.items.length, 2);
  } finally {
    server.close();
  }
});

test('ads review:campaigns.items 按状态排序后再截断(在投的不会被砍掉)', async () => {
  // 回归:旧实现按接口原始顺序截断,--top 可能正好砍掉在投的活动、留一堆归档的,
  // 与 --top 的说明("排序后取前 N")也对不上。
  const campaigns = [
    ...Array.from({ length: 5 }, (_, i) => ({ campaignId: `arch${i}`, name: `Arch ${i}`, state: 'ARCHIVED' })),
    { campaignId: 'paused1', name: 'Paused', state: 'PAUSED' },
    { campaignId: 'live1', name: 'Live', state: 'ENABLED' },
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(gzipSync(JSON.stringify([])));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10', top: '2' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') return { campaigns };
        if (method === 'POST' && path === '/reporting/reports') {
          return { reportId: `r-${opts.body.configuration.reportTypeId}` };
        }
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/x` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    // top=2 时留下的必须是 ENABLED + PAUSED，而不是排在前面的 5 个 ARCHIVED
    assert.deepEqual(result.campaigns.items.map((c) => c.campaignId), ['live1', 'paused1']);
    assert.equal(result.campaigns.itemsTruncated, true);
    // 计数仍按全量
    assert.equal(result.campaigns.total, 7);
    assert.equal(result.campaigns.archived, 5);
  } finally {
    server.close();
  }
});

test('ads review:废词也受上限约束,且 ASIN 聚焦仍从全量废词里找', async () => {
  // 回归:--top 原本只管 performance 和 campaigns.items,wastedTerms 不设上限,
  // 大账户上几千个废词照样把 payload 撑爆 —— 截断目标只完成了一半。
  const N = 30;
  const terms = Array.from({ length: N }, (_, i) => ({
    date: '2026-08-01',
    campaignId: i === 25 ? 'target' : `c${i}`,
    adGroupId: 'g1',
    searchTerm: `term-${i}`,
    clicks: 50,
    cost: N - i, // 花费递减 → term-0 最费钱排最前,target(i=25)排在很后面
    purchases7d: 0,
  }));

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const rows =
      req.url === '/r-spSearchTerm'
        ? terms
        : req.url === '/r-spAdvertisedProduct'
          ? [{ date: '2026-08-01', campaignId: 'target', advertisedAsin: 'B0TESTASIN', clicks: 1, cost: 1, purchases7d: 0, sales7d: 0, impressions: 1 }]
          : [];
    res.end(gzipSync(JSON.stringify(rows)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10', top: '5', asin: 'B0TESTASIN' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') return { campaigns: [] };
        if (method === 'POST' && path === '/reporting/reports') {
          return { reportId: `r-${opts.body.configuration.reportTypeId}` };
        }
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${path.split('/').pop()}` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    // --limit 没给时跟随 --top
    assert.equal(result.wastedTerms.length, 5);
    assert.equal(result.wastedTermsShown, 5);
    assert.equal(result.wastedTermsCount, N);
    assert.equal(result.wastedTermsTruncated, true);
    // 目标活动的废词排在第 26 位(截断线外),ASIN 聚焦必须仍能找到
    assert.equal(result.wastedTerms.some((t) => t.campaignId === 'target'), false, '前提:目标废词确实被截断了');
    assert.deepEqual(result.asinFocus.wastedTerms.map((t) => t.campaignId), ['target']);
    // note 要如实反映本次的条数,不能硬编码 100
    assert.match(result.note, /本次各最多给 5 \/ 5 条/);
  } finally {
    server.close();
  }
});

test('ads review:--limit 显式指定时废词用它,与 --top 各管各的', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const rows =
      req.url === '/r-spSearchTerm'
        ? Array.from({ length: 10 }, (_, i) => ({
            date: '2026-08-01', campaignId: `c${i}`, adGroupId: 'g', searchTerm: `t${i}`,
            clicks: 20, cost: 10 - i, purchases7d: 0,
          }))
        : [];
    res.end(gzipSync(JSON.stringify(rows)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    flags: { profileId: '123', start: '2026-08-01', end: '2026-08-10', top: '2', limit: '7' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (path === '/sp/campaigns/list') return { campaigns: [] };
        if (method === 'POST' && path === '/reporting/reports') return { reportId: `r-${opts.body.configuration.reportTypeId}` };
        return { status: 'COMPLETED', url: `http://127.0.0.1:${port}/${path.split('/').pop()}` };
      },
    },
  };

  try {
    const result = await adsReview.execute(ctx);
    assert.equal(result.wastedTerms.length, 7, '--limit 优先于 --top');
    assert.equal(result.wastedTermsCount, 10);
  } finally {
    server.close();
  }
});
