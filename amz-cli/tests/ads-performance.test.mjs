import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateAdsPerformance } from '../dist/shortcuts/ads/performance.js';

// 两天明细,故意用能整除的数,避免浮点误差
const rows = [
  // c1 Alpha:两天各 cost5/sales20 → cost10 sales40 acos25 orders2 clicks20 impr200
  { date: '2026-07-01', campaignId: 'c1', campaignName: 'Alpha', impressions: 100, clicks: 10, cost: 5, purchases7d: 1, sales7d: 20 },
  { date: '2026-07-02', campaignId: 'c1', campaignName: 'Alpha', impressions: 100, clicks: 10, cost: 5, purchases7d: 1, sales7d: 20 },
  // c2 Beta:有花费零销售额 → spendNoSales
  { date: '2026-07-01', campaignId: 'c2', campaignName: 'Beta', impressions: 50, clicks: 8, cost: 8, purchases7d: 0, sales7d: 0 },
  // c3 Gamma:acos 100%
  { date: '2026-07-01', campaignId: 'c3', campaignName: 'Gamma', impressions: 80, clicks: 4, cost: 2, purchases7d: 1, sales7d: 2 },
];

test('按活动汇总天级明细,算 ACOS/CTR/CVR/CPC', () => {
  const out = aggregateAdsPerformance(rows, { by: 'campaign', minSpend: 0 });
  const c1 = out.find((r) => r.campaignId === 'c1');
  assert.deepEqual(
    { ...c1 },
    {
      campaignId: 'c1',
      campaignName: 'Alpha',
      impressions: 200,
      clicks: 20,
      cost: 10,
      orders: 2,
      sales: 40,
      acos: 25.0,
      ctr: 10.0,
      cvr: 10.0,
      cpc: 0.5,
      spendNoSales: false,
    },
  );
});

test('排序:有花费零单排最前,其次 ACOS 降序', () => {
  const out = aggregateAdsPerformance(rows, { by: 'campaign', minSpend: 0 });
  assert.deepEqual(out.map((r) => r.campaignId), ['c2', 'c3', 'c1']);
  assert.equal(out[0].spendNoSales, true);
  assert.equal(out[0].acos, null); // 零销售额 → acos 为 null
});

test('minSpend 过滤低花费噪声', () => {
  const out = aggregateAdsPerformance(rows, { by: 'campaign', minSpend: 3 });
  assert.deepEqual(out.map((r) => r.campaignId).sort(), ['c1', 'c2']); // c3 cost2 被过滤
});

test('acosMin 只留超标,但有花费零单始终保留', () => {
  const out = aggregateAdsPerformance(rows, { by: 'campaign', minSpend: 0, acosMin: 50 });
  assert.deepEqual(out.map((r) => r.campaignId), ['c2', 'c3']); // c1 acos25 被筛掉;c2 零单保留;c3 acos100
});

test('limit 截断,最差优先', () => {
  const out = aggregateAdsPerformance(rows, { by: 'campaign', minSpend: 0, limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].campaignId, 'c2');
});

test('by ad-group:同活动不同广告组分开汇总,带 adGroupId/Name', () => {
  const agRows = [
    { campaignId: 'c1', campaignName: 'Alpha', adGroupId: 'g1', adGroupName: 'AG1', impressions: 100, clicks: 10, cost: 5, purchases7d: 1, sales7d: 20 },
    { campaignId: 'c1', campaignName: 'Alpha', adGroupId: 'g2', adGroupName: 'AG2', impressions: 50, clicks: 5, cost: 5, purchases7d: 0, sales7d: 0 },
  ];
  const out = aggregateAdsPerformance(agRows, { by: 'ad-group', minSpend: 0 });
  assert.equal(out.length, 2);
  const g2 = out.find((r) => r.adGroupId === 'g2');
  assert.equal(g2.adGroupName, 'AG2');
  assert.equal(g2.spendNoSales, true);
  assert.equal(out[0].adGroupId, 'g2'); // 零单排前
});
