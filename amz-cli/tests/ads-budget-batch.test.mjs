import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmzError } from '../dist/internal/errs/errors.js';
import {
  adsBudgetBatch,
  fetchCurrentBudgets,
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

test('fetchCurrentBudgets 传 maxResults 并跟随 nextToken 翻页合并', async () => {
  const calls = [];
  const client = {
    async request(method, path, opts) {
      calls.push({ method, path, opts });
      if (calls.length === 1) {
        return { campaigns: [{ campaignId: '10', budget: { budget: 20 } }], nextToken: 'page-2' };
      }
      return { campaigns: [{ campaignId: '20', budget: { budget: 30 } }] };
    },
  };
  const out = await fetchCurrentBudgets(client, '123', ['10', '20']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.body.maxResults, 2);
  assert.equal(calls[0].opts.body.nextToken, undefined);
  assert.equal(calls[1].opts.body.nextToken, 'page-2');
  assert.deepEqual(out, [
    { campaignId: '10', dailyBudget: 20, name: undefined },
    { campaignId: '20', dailyBudget: 30, name: undefined },
  ]);
});

test('fetchCurrentBudgets nextToken 死循环时页数熔断', async () => {
  const client = { async request() { return { campaigns: [], nextToken: 'again' }; } };
  await assert.rejects(
    fetchCurrentBudgets(client, '123', ['10']),
    (error) => error instanceof AmzError && error.subtype === 'ads.budget_batch_pagination_limit',
  );
});

test('execute:结果不明(网络中断/形状未知)计入 resultUnknown,与 failed 区分', async () => {
  const ctx = {
    flags: { profileId: '123', changes: JSON.stringify([{ campaignId: '10', dailyBudget: 25 }]) },
    confirmationState: [{ campaignId: '10', dailyBudget: 20, name: 'A' }],
    progress() {},
    adsClient: {
      async request() {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'ads.write_result_unknown',
          hintAgent: 'report_to_human',
          hintHuman: 'unknown',
          message: 'connection reset after dispatch',
        });
      },
    },
  };
  const result = await adsBudgetBatch.execute(ctx);
  assert.equal(result.failedCount, 0);
  assert.equal(result.resultUnknownCount, 1);
  assert.equal(result.resultUnknown[0].campaignId, '10');
  assert.match(result.result_unknown_note, /不要直接重跑/);
});
