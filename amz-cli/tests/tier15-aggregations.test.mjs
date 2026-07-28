import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectLowStock } from '../dist/shortcuts/inventory/low-stock.js';
import { summarizeReimbursements } from '../dist/shortcuts/reimbursements/list.js';

// ---- inventory low-stock ----
test('selectLowStock 只留可售天数<=maxDays,按天数升序(最紧急在前)', () => {
  const rows = [
    { sku: 'A', asin: 'B0A', 'product-name': '品A', available: '30', 'days-of-supply': '12', 'recommended-replenishment-qty': '100' },
    { sku: 'B', asin: 'B0B', available: '5', 'days-of-supply': '3' },
    { sku: 'C', asin: 'B0C', available: '500', 'days-of-supply': '90' }, // 充足,排除
    { sku: 'D', asin: 'B0D', available: '10' }, // 无 days-of-supply(无销速),跳过
  ];
  const out = selectLowStock(rows, { maxDays: 14 });
  assert.deepEqual(out.map((i) => i.sku), ['B', 'A']); // 3 天 < 12 天
  assert.equal(out[1].recommendedReplenishmentQty, 100);
});

test('selectLowStock 跳过 days-of-supply 非数字的行', () => {
  const rows = [{ sku: 'X', 'days-of-supply': 'N/A', available: '1' }];
  assert.deepEqual(selectLowStock(rows, { maxDays: 30 }), []);
});

test('selectLowStock limit 截断', () => {
  const rows = [
    { sku: 'A', 'days-of-supply': '1' },
    { sku: 'B', 'days-of-supply': '2' },
    { sku: 'C', 'days-of-supply': '3' },
  ];
  const out = selectLowStock(rows, { maxDays: 14, limit: 2 });
  assert.deepEqual(out.map((i) => i.sku), ['A', 'B']);
});

// ---- reimbursements list ----
test('summarizeReimbursements 合计金额 + 按原因/按 SKU 拆分', () => {
  const rows = [
    { sku: 'A', asin: 'B0A', reason: 'Lost_Warehouse', 'amount-total': '10.5', 'currency-unit': 'USD' },
    { sku: 'A', asin: 'B0A', reason: 'Lost_Warehouse', 'amount-total': '4.5', 'currency-unit': 'USD' },
    { sku: 'B', asin: 'B0B', reason: 'Damaged_Warehouse', 'amount-total': '20', 'currency-unit': 'USD' },
  ];
  const out = summarizeReimbursements(rows, { limit: 20 });
  assert.equal(out.totalAmount, 35);
  assert.equal(out.currency, 'USD');
  assert.equal(out.count, 3);
  assert.deepEqual(out.byReason, [
    { reason: 'Damaged_Warehouse', amount: 20, count: 1 },
    { reason: 'Lost_Warehouse', amount: 15, count: 2 },
  ]);
  assert.deepEqual(out.topSkus, [
    { sku: 'B', asin: 'B0B', amount: 20, count: 1 },
    { sku: 'A', asin: 'B0A', amount: 15, count: 2 },
  ]);
});

test('summarizeReimbursements 无 SKU 的行只进金额与原因,不进 topSkus', () => {
  const rows = [{ reason: 'FeeCorrection', 'amount-total': '7', 'currency-unit': 'USD' }];
  const out = summarizeReimbursements(rows, { limit: 20 });
  assert.equal(out.totalAmount, 7);
  assert.equal(out.topSkus.length, 0);
  assert.deepEqual(out.byReason, [{ reason: 'FeeCorrection', amount: 7, count: 1 }]);
});

test('summarizeReimbursements topSkus 受 limit 限制', () => {
  const rows = [
    { sku: 'A', reason: 'x', 'amount-total': '3' },
    { sku: 'B', reason: 'x', 'amount-total': '2' },
    { sku: 'C', reason: 'x', 'amount-total': '1' },
  ];
  const out = summarizeReimbursements(rows, { limit: 2 });
  assert.deepEqual(out.topSkus.map((s) => s.sku), ['A', 'B']);
});
