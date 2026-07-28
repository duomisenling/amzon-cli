import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSlowMoving } from '../dist/shortcuts/inventory/slow-moving.js';

test('selectSlowMoving 只留可售天数>=阈值,按可售天数降序(最压货在前)', () => {
  const rows = [
    { sku: 'A', asin: 'B0A', 'product-name': '压货A', available: '200', 'days-of-supply': '366', 'sell-through': '0.2', 'estimated-storage-cost-next-month': '30', 'estimated-excess-quantity': '0' },
    { sku: 'B', asin: 'B0B', available: '50', 'days-of-supply': '120', 'sell-through': '0.5' },
    { sku: 'C', asin: 'B0C', available: '10', 'days-of-supply': '15' }, // 周转健康,排除
  ];
  const out = selectSlowMoving(rows, { minDaysSupply: 90 });
  assert.deepEqual(out.map((i) => i.sku), ['A', 'B']); // 366 > 120
  assert.equal(out[0].daysOfSupply, 366);
  assert.equal(out[0].sellThrough, 0.2);
  assert.equal(out[0].excessQuantity, 0); // 亚马逊冗余量常年 0,仅作参考带出
  assert.equal(out[0].estStorageCostNextMonth, 30);
});

test('selectSlowMoving 跳过可售天数为空(数据不足)的行', () => {
  const rows = [
    { sku: 'A', 'days-of-supply': '', available: '5' },
    { sku: 'B', available: '9' }, // 无该列
  ];
  assert.deepEqual(selectSlowMoving(rows, { minDaysSupply: 90 }), []);
});

test('selectSlowMoving 阈值可调', () => {
  const rows = [
    { sku: 'A', 'days-of-supply': '366' },
    { sku: 'B', 'days-of-supply': '120' },
  ];
  const out = selectSlowMoving(rows, { minDaysSupply: 300 });
  assert.deepEqual(out.map((i) => i.sku), ['A']);
});

test('selectSlowMoving limit 截断', () => {
  const rows = [
    { sku: 'A', 'days-of-supply': '366' },
    { sku: 'B', 'days-of-supply': '300' },
    { sku: 'C', 'days-of-supply': '200' },
  ];
  const out = selectSlowMoving(rows, { minDaysSupply: 90, limit: 2 });
  assert.deepEqual(out.map((i) => i.sku), ['A', 'B']);
});
