import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateWastedSpend,
  wastedOptionsFromFlags,
} from '../dist/shortcuts/ads/wasted-spend.js';

const rows = [
  // t1:两天各 5 点击/花费 2,零转化 → clicks10 cost4,应命中
  { date: '2026-07-01', campaignId: 'c1', adGroupId: 'g1', searchTerm: 'waste term', clicks: 5, cost: 2, purchases7d: 0 },
  { date: '2026-07-02', campaignId: 'c1', adGroupId: 'g1', searchTerm: 'waste term', clicks: 5, cost: 2, purchases7d: 0 },
  // t2:点击多但有转化 → 不算浪费
  { date: '2026-07-01', campaignId: 'c1', adGroupId: 'g1', searchTerm: 'good term', clicks: 20, cost: 6, purchases7d: 2 },
  // t3:零转化但点击不足默认阈值 10
  { date: '2026-07-01', campaignId: 'c2', adGroupId: 'g2', searchTerm: 'few clicks', clicks: 3, cost: 9, purchases7d: 0 },
];

test('aggregateWastedSpend 按词汇总,只留 点击≥minClicks 且 0 转化', () => {
  const out = aggregateWastedSpend(rows, { minClicks: 10 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    searchTerm: 'waste term',
    campaignId: 'c1',
    adGroupId: 'g1',
    clicks: 10,
    cost: 4,
    purchases: 0,
  });
});

test('aggregateWastedSpend minClicks 降低阈值后按花费降序', () => {
  const out = aggregateWastedSpend(rows, { minClicks: 1 });
  assert.deepEqual(out.map((t) => t.searchTerm), ['few clicks', 'waste term']); // cost 9 > 4
});

test('wastedOptionsFromFlags:未提供时用默认 minClicks=10 / timeout=10,无 limit', () => {
  assert.deepEqual(wastedOptionsFromFlags({}), { minClicks: 10, timeout: 10 });
});

test('wastedOptionsFromFlags:空串/全空白不绕过默认值(strFlag 口径)', () => {
  // 空串会被 validateNumberFlag 跳过校验;直接 Number('') 是 0,曾把 minClicks 变成 0
  assert.deepEqual(wastedOptionsFromFlags({ minClicks: '', limit: '   ', timeout: '' }), {
    minClicks: 10,
    timeout: 10,
  });
});

test('wastedOptionsFromFlags:显式值正常解析', () => {
  assert.deepEqual(wastedOptionsFromFlags({ minClicks: '5', limit: '3', timeout: '20' }), {
    minClicks: 5,
    limit: 3,
    timeout: 20,
  });
});
