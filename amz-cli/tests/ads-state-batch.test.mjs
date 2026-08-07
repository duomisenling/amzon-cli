import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmzError } from '../dist/internal/errs/errors.js';
import {
  adsStateBatch,
  fetchCurrentCampaigns,
  parseStateChanges,
  planStateChanges,
  MAX_STATE_BATCH,
} from '../dist/shortcuts/ads/state-batch.js';

test('parseStateChanges 去重、排序、state 大小写不敏感', () => {
  const out = parseStateChanges([
    { campaignId: 20, state: 'paused' },
    { campaignId: '10', state: 'ENABLED' },
  ]);
  assert.deepEqual(out, [
    { campaignId: '10', state: 'ENABLED' },
    { campaignId: '20', state: 'PAUSED' },
  ]);
});

test('parseStateChanges 拒绝非数组/空/超量/非法字段/重复', () => {
  assert.throws(() => parseStateChanges('x'), /must be a JSON array/);
  assert.throws(() => parseStateChanges([]), /empty/);
  const tooMany = Array.from({ length: MAX_STATE_BATCH + 1 }, (_, i) => ({ campaignId: String(i + 1), state: 'PAUSED' }));
  assert.throws(() => parseStateChanges(tooMany), /exceed max/);
  assert.throws(() => parseStateChanges([{ campaignId: 'x', state: 'PAUSED' }]), /invalid campaignId/);
  assert.throws(() => parseStateChanges([{ campaignId: '1', state: 'ARCHIVED' }]), /invalid state/);
  assert.throws(
    () => parseStateChanges([{ campaignId: '1', state: 'PAUSED' }, { campaignId: '1', state: 'ENABLED' }]),
    /duplicate/,
  );
});

test('planStateChanges 分出 change / no-change / not-found', () => {
  const current = [
    { campaignId: '10', state: 'ENABLED', name: 'A' },
    { campaignId: '20', state: 'ENABLED', name: 'B' },
  ];
  const changes = [
    { campaignId: '10', state: 'ENABLED' }, // 等值 → no-change
    { campaignId: '20', state: 'PAUSED' }, // 变化 → change
    { campaignId: '30', state: 'PAUSED' }, // 远端没有 → not-found
  ];
  const plan = planStateChanges(changes, current);
  assert.deepEqual(plan.willChange, [{ campaignId: '20', state: 'PAUSED' }]);
  assert.deepEqual(plan.noChange, [{ campaignId: '10', state: 'ENABLED' }]);
  assert.deepEqual(plan.notFound, [{ campaignId: '30', state: 'PAUSED' }]);
  const r20 = plan.rows.find((r) => r.campaignId === '20');
  assert.deepEqual(
    { ...r20 },
    { campaignId: '20', name: 'B', currentState: 'ENABLED', newState: 'PAUSED', status: 'change' },
  );
  const r30 = plan.rows.find((r) => r.campaignId === '30');
  assert.equal(r30.status, 'not-found');
  assert.equal(r30.currentState, undefined);
});

test('planStateChanges 当前 ARCHIVED 的活动归入 notApplicable,不进 willChange', () => {
  const plan = planStateChanges(
    [
      { campaignId: '10', state: 'ENABLED' },
      { campaignId: '20', state: 'PAUSED' },
    ],
    [
      { campaignId: '10', state: 'ARCHIVED', name: 'Dead' },
      { campaignId: '20', state: 'ENABLED', name: 'Live' },
    ],
  );
  assert.deepEqual(plan.willChange, [{ campaignId: '20', state: 'PAUSED' }]);
  assert.deepEqual(plan.notApplicable, [{ campaignId: '10', state: 'ENABLED' }]);
  const r10 = plan.rows.find((r) => r.campaignId === '10');
  assert.equal(r10.status, 'not-applicable');
  assert.match(r10.reason, /归档/);
});

test('fetchCurrentCampaigns 传 maxResults 并跟随 nextToken 翻页合并;死循环时熔断', async () => {
  const calls = [];
  const client = {
    async request(method, path, opts) {
      calls.push({ method, path, opts });
      if (calls.length === 1) {
        return { campaigns: [{ campaignId: '10', state: 'ENABLED' }], nextToken: 'page-2' };
      }
      return { campaigns: [{ campaignId: '20', state: 'PAUSED' }] };
    },
  };
  const out = await fetchCurrentCampaigns(client, '123', ['10', '20']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.body.maxResults, 2);
  assert.equal(calls[1].opts.body.nextToken, 'page-2');
  assert.deepEqual(out.map((c) => c.campaignId), ['10', '20']);

  const endless = { async request() { return { campaigns: [], nextToken: 'again' }; } };
  await assert.rejects(
    fetchCurrentCampaigns(endless, '123', ['10']),
    (error) => error instanceof AmzError && error.subtype === 'ads.state_batch_pagination_limit',
  );
});

test('execute:结果不明(网络中断/形状未知)计入 resultUnknown,与 failed 区分', async () => {
  const ctx = {
    flags: { profileId: '123', changes: JSON.stringify([{ campaignId: '10', state: 'PAUSED' }]) },
    confirmationState: [{ campaignId: '10', state: 'ENABLED', name: 'A' }],
    progress() {},
    adsClient: {
      async request() {
        return {}; // 形状未知:不判成功也不判失败
      },
    },
  };
  const result = await adsStateBatch.execute(ctx);
  assert.equal(result.failedCount, 0);
  assert.equal(result.resultUnknownCount, 1);
  assert.equal(result.resultUnknown[0].reason, 'UNKNOWN_RESPONSE_SHAPE');
  assert.match(result.result_unknown_note, /不要直接重跑/);
});
