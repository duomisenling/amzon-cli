import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseBudgetChanges,
  planBudgetChanges,
  MAX_BUDGET_BATCH,
} from '../dist/shortcuts/ads/budget-batch.js';

test('parseBudgetChanges 去重、排序、两位小数,兼容 budget/dailyBudget 键', () => {
  const out = parseBudgetChanges([
    { campaignId: 20, dailyBudget: 15.005 },
    { campaignId: '10', budget: 30 },
  ]);
  assert.deepEqual(out, [
    { campaignId: '10', dailyBudget: 30 },
    { campaignId: '20', dailyBudget: 15.01 },
  ]);
});

test('parseBudgetChanges 拒绝非数组/空/超量/非法/重复', () => {
  assert.throws(() => parseBudgetChanges('x'), /must be a JSON array/);
  assert.throws(() => parseBudgetChanges([]), /empty/);
  const tooMany = Array.from({ length: MAX_BUDGET_BATCH + 1 }, (_, i) => ({ campaignId: String(i + 1), dailyBudget: 10 }));
  assert.throws(() => parseBudgetChanges(tooMany), /exceed max/);
  assert.throws(() => parseBudgetChanges([{ campaignId: 'x', dailyBudget: 10 }]), /invalid campaignId/);
  assert.throws(() => parseBudgetChanges([{ campaignId: '1', dailyBudget: 0 }]), /invalid dailyBudget/);
  assert.throws(
    () => parseBudgetChanges([{ campaignId: '1', dailyBudget: 10 }, { campaignId: '1', dailyBudget: 20 }]),
    /duplicate/,
  );
});

test('planBudgetChanges 分出 change / no-change / not-found(两位小数比)', () => {
  const current = [
    { campaignId: '10', dailyBudget: 20, name: 'A' },
    { campaignId: '20', dailyBudget: 30.0000001, name: 'B' },
  ];
  const changes = [
    { campaignId: '10', dailyBudget: 25 }, // 变化
    { campaignId: '20', dailyBudget: 30 }, // 归一后等值 → no-change
    { campaignId: '30', dailyBudget: 5 }, // 找不到
  ];
  const plan = planBudgetChanges(changes, current);
  assert.deepEqual(plan.willChange, [{ campaignId: '10', dailyBudget: 25 }]);
  assert.deepEqual(plan.noChange, [{ campaignId: '20', dailyBudget: 30 }]);
  assert.deepEqual(plan.notFound, [{ campaignId: '30', dailyBudget: 5 }]);
  const r10 = plan.rows.find((r) => r.campaignId === '10');
  assert.deepEqual({ ...r10 }, { campaignId: '10', name: 'A', currentBudget: 20, newBudget: 25, status: 'change' });
});
