import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectAgedInventory, bucketsForMinAge } from '../dist/shortcuts/inventory/aged.js';
import { selectStrandedInventory } from '../dist/shortcuts/inventory/stranded.js';
import { aggregateReturnsBySku } from '../dist/shortcuts/returns/by-sku.js';
import { aggregateWastedSpend } from '../dist/shortcuts/ads/wasted-spend.js';

// ---- inventory aged ----
test('selectAgedInventory 按 minAgeDays 取更老的档,按老货单位数降序,带库龄档明细', () => {
  const rows = [
    { sku: 'A', asin: 'B0A', 'product-name': '货A', available: '20', 'inv-age-181-to-270-days': '5', 'inv-age-271-to-365-days': '3', 'inv-age-365-plus-days': '2', 'estimated-storage-cost-next-month': '12.5' },
    { sku: 'B', asin: 'B0B', 'inv-age-271-to-365-days': '10' },
    { sku: 'C', asin: 'B0C', 'inv-age-0-to-30-days': '100' }, // 全新,无老货,排除
  ];
  const out = selectAgedInventory(rows, { minAgeDays: 271, minUnits: 1 });
  assert.deepEqual(out.map((i) => i.sku), ['B', 'A']); // B:10, A:5(3+2)
  assert.equal(out[1].agedUnits, 5);
  assert.deepEqual(out[1].breakdown, { '271-365': 3, '365+': 2 });
  assert.equal(out[1].estStorageCostNextMonth, 12.5);
});

test('selectAgedInventory 阈值放低到 181 把 181-270 档也计入', () => {
  const rows = [{ sku: 'A', 'inv-age-181-to-270-days': '5', 'inv-age-271-to-365-days': '3', 'inv-age-365-plus-days': '2' }];
  const out = selectAgedInventory(rows, { minAgeDays: 181, minUnits: 1 });
  assert.equal(out[0].agedUnits, 10);
  assert.deepEqual(out[0].breakdown, { '181-270': 5, '271-365': 3, '365+': 2 });
});

test('selectAgedInventory 阈值 100 计入相交的 91-180 档,不再静默变成 181 起', () => {
  const rows = [{ sku: 'A', 'inv-age-91-to-180-days': '7', 'inv-age-181-to-270-days': '5' }];
  const out = selectAgedInventory(rows, { minAgeDays: 100, minUnits: 1 });
  assert.equal(out[0].agedUnits, 12); // 修复前 91-180 整档被丢,只剩 5
  assert.deepEqual(out[0].breakdown, { '91-180': 7, '181-270': 5 });
});

test('bucketsForMinAge 取与阈值相交的档;高阈值仍有 365+ 开区间档兜底,不会恒为空', () => {
  assert.deepEqual(bucketsForMinAge(100).map((b) => b.label), ['91-180', '181-270', '271-365', '365+']);
  assert.deepEqual(bucketsForMinAge(0).map((b) => b.label), ['0-30', '31-60', '61-90', '91-180', '181-270', '271-365', '365+']);
  assert.deepEqual(bucketsForMinAge(400).map((b) => b.label), ['365+']); // 修复前 lo>=400 匹配不到任何档
  assert.deepEqual(bucketsForMinAge(3650).map((b) => b.label), ['365+']);
});

// ---- inventory stranded ----
test('selectStrandedInventory 只留有滞留单位的,按数量降序', () => {
  const rows = [
    { sku: 'A', asin: 'B0A', 'product-name': '滞留A', 'available-quantity': '4', 'status-primary': 'Stranded' },
    { sku: 'B', asin: 'B0B', quantity: '9', 'stranded-reason': 'Listing removed' },
    { sku: 'C', asin: 'B0C', 'available-quantity': '0' },
  ];
  const out = selectStrandedInventory(rows, { minUnits: 1 });
  assert.deepEqual(out.map((i) => i.sku), ['B', 'A']);
  assert.equal(out[1].reason, 'Stranded');
});

// ---- returns by-sku ----
test('aggregateReturnsBySku 按 SKU 汇总数量/笔数/主因', () => {
  const rows = [
    { sku: 'A', asin: 'B0A', 'product-name': '品A', quantity: '1', reason: 'DEFECTIVE' },
    { sku: 'A', asin: 'B0A', quantity: '2', reason: 'DEFECTIVE' },
    { sku: 'A', asin: 'B0A', quantity: '1', reason: 'NO_REASON_GIVEN' },
    { sku: 'B', asin: 'B0B', quantity: '5', reason: 'UNWANTED_ITEM' },
  ];
  const out = aggregateReturnsBySku(rows, { minUnits: 1 });
  assert.deepEqual(out.map((i) => i.sku), ['B', 'A']); // B:5 > A:4
  const a = out.find((i) => i.sku === 'A');
  assert.equal(a.returnedUnits, 4);
  assert.equal(a.returnEvents, 3);
  assert.equal(a.topReason, 'DEFECTIVE'); // 3 vs 1
});

test('aggregateReturnsBySku 明细无 quantity 时按 1 笔计,minUnits 可过滤', () => {
  const rows = [
    { sku: 'A', reason: 'X' },
    { sku: 'A', reason: 'X' },
    { sku: 'B', reason: 'Y' },
  ];
  const out = aggregateReturnsBySku(rows, { minUnits: 2 });
  assert.deepEqual(out.map((i) => i.sku), ['A']);
  assert.equal(out[0].returnedUnits, 2);
});

// ---- ads wasted-spend ----
test('aggregateWastedSpend 只留点击达标且零转化的词,按花费降序', () => {
  const rows = [
    { campaignId: 'c1', adGroupId: 'g1', searchTerm: 'wasted big', clicks: 8, cost: 4.2, purchases7d: 0 },
    { campaignId: 'c1', adGroupId: 'g1', searchTerm: 'wasted big', clicks: 7, cost: 3.8, purchases7d: 0 }, // 累加到 15 点击 / 8.0 花费
    { campaignId: 'c1', adGroupId: 'g1', searchTerm: 'converts', clicks: 20, cost: 10, purchases7d: 2 }, // 有转化,排除
    { campaignId: 'c2', adGroupId: 'g2', searchTerm: 'wasted small', clicks: 12, cost: 3, purchases7d: 0 },
    { campaignId: 'c3', adGroupId: 'g3', searchTerm: 'too few', clicks: 3, cost: 9, purchases7d: 0 }, // 点击不足,排除
  ];
  const out = aggregateWastedSpend(rows, { minClicks: 10 });
  assert.deepEqual(out.map((t) => t.searchTerm), ['wasted big', 'wasted small']);
  assert.equal(out[0].clicks, 15);
  assert.equal(out[0].cost, 8); // 累加后按两位小数
  assert.equal(out[0].campaignId, 'c1');
});

test('aggregateWastedSpend limit 截断', () => {
  const rows = [
    { searchTerm: 't1', clicks: 10, cost: 5, purchases7d: 0 },
    { searchTerm: 't2', clicks: 10, cost: 3, purchases7d: 0 },
  ];
  const out = aggregateWastedSpend(rows, { minClicks: 10, limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].searchTerm, 't1');
});
