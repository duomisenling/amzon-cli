import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmzError } from '../dist/internal/errs/errors.js';
import {
  adsBidBatch,
  fetchCurrentKeywords,
  parseBidChanges,
  planBidChanges,
  MAX_BID_BATCH,
} from '../dist/shortcuts/ads/bid-batch.js';

test('parseBidChanges 去重前提下按 keywordId 排序、bid 两位小数', () => {
  const out = parseBidChanges([
    { keywordId: 20, bid: 0.5 },
    { keywordId: '10', bid: 1.259 },
  ]);
  assert.deepEqual(out, [
    { keywordId: '10', bid: 1.26 },
    { keywordId: '20', bid: 0.5 },
  ]);
});

test('parseBidChanges 拒绝非数组/空/超量', () => {
  // assert.throws 的正则匹配 error.message(英文契约文案),不是 hintHuman
  assert.throws(() => parseBidChanges({}), /must be a JSON array/);
  assert.throws(() => parseBidChanges([]), /empty/);
  const tooMany = Array.from({ length: MAX_BID_BATCH + 1 }, (_, i) => ({ keywordId: String(i + 1), bid: 1 }));
  assert.throws(() => parseBidChanges(tooMany), /exceed max/);
});

test('parseBidChanges 拒绝非法 keywordId / bid / 重复', () => {
  assert.throws(() => parseBidChanges([{ keywordId: 'abc', bid: 1 }]), /invalid keywordId/);
  assert.throws(() => parseBidChanges([{ keywordId: '1', bid: 0 }]), /invalid bid/);
  assert.throws(() => parseBidChanges([{ keywordId: '1', bid: -2 }]), /invalid bid/);
  assert.throws(() => parseBidChanges([{ keywordId: '1', bid: 20000 }]), /invalid bid/);
  assert.throws(() => parseBidChanges([{ keywordId: '1', bid: 'x' }]), /invalid bid/);
  assert.throws(
    () => parseBidChanges([{ keywordId: '1', bid: 1 }, { keywordId: '1', bid: 2 }]),
    /duplicate keywordId/,
  );
});

test('planBidChanges 分出 change / no-change / not-found', () => {
  const current = [
    { keywordId: '10', bid: 0.5, state: 'ENABLED', keywordText: 'foo' },
    { keywordId: '20', bid: 0.8, state: 'ENABLED', keywordText: 'bar' },
  ];
  const changes = [
    { keywordId: '10', bid: 0.5 }, // 等值 → no-change
    { keywordId: '20', bid: 1.0 }, // 变化 → change
    { keywordId: '30', bid: 0.9 }, // 远端没有 → not-found
  ];
  const plan = planBidChanges(changes, current);
  assert.deepEqual(plan.willChange, [{ keywordId: '20', bid: 1.0 }]);
  assert.deepEqual(plan.noChange, [{ keywordId: '10', bid: 0.5 }]);
  assert.deepEqual(plan.notFound, [{ keywordId: '30', bid: 0.9 }]);
  assert.equal(plan.rows.length, 3);
  const r20 = plan.rows.find((r) => r.keywordId === '20');
  assert.deepEqual(
    { ...r20 },
    { keywordId: '20', keywordText: 'bar', state: 'ENABLED', currentBid: 0.8, newBid: 1.0, status: 'change' },
  );
  const r30 = plan.rows.find((r) => r.keywordId === '30');
  assert.equal(r30.status, 'not-found');
  assert.equal(r30.currentBid, undefined);
});

test('planBidChanges 当前竞价两位小数归一后再比,避免浮点误报', () => {
  const plan = planBidChanges([{ keywordId: '1', bid: 0.8 }], [{ keywordId: '1', bid: 0.8000001 }]);
  assert.equal(plan.willChange.length, 0);
  assert.equal(plan.noChange.length, 1);
});

test('planBidChanges 当前 ARCHIVED 的关键词归入 notApplicable,不进 willChange', () => {
  const plan = planBidChanges(
    [
      { keywordId: '10', bid: 1.0 },
      { keywordId: '20', bid: 1.0 },
    ],
    [
      { keywordId: '10', bid: 0.5, state: 'ARCHIVED', keywordText: 'dead' },
      { keywordId: '20', bid: 0.5, state: 'ENABLED', keywordText: 'live' },
    ],
  );
  assert.deepEqual(plan.willChange, [{ keywordId: '20', bid: 1.0 }]);
  assert.deepEqual(plan.notApplicable, [{ keywordId: '10', bid: 1.0 }]);
  const r10 = plan.rows.find((r) => r.keywordId === '10');
  assert.equal(r10.status, 'not-applicable');
  assert.match(r10.reason, /归档/);
});

test('fetchCurrentKeywords 传 maxResults 并跟随 nextToken 翻页合并', async () => {
  const calls = [];
  const client = {
    async request(method, path, opts) {
      calls.push({ method, path, opts });
      if (calls.length === 1) {
        return { keywords: [{ keywordId: '10', bid: 0.5 }], nextToken: 'page-2' };
      }
      return { keywords: [{ keywordId: '20', bid: 0.8 }] };
    },
  };
  const out = await fetchCurrentKeywords(client, '123', ['10', '20']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.body.maxResults, 2);
  assert.equal(calls[0].opts.body.nextToken, undefined);
  assert.equal(calls[1].opts.body.nextToken, 'page-2');
  assert.deepEqual(out.map((k) => k.keywordId), ['10', '20']);
});

test('fetchCurrentKeywords nextToken 死循环时页数熔断,不静默丢数据', async () => {
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      return { keywords: [], nextToken: 'again' };
    },
  };
  await assert.rejects(
    fetchCurrentKeywords(client, '123', ['10']),
    (error) => error instanceof AmzError && error.subtype === 'ads.bid_batch_pagination_limit',
  );
  assert.equal(calls, 100);
});

function executeCtx(response) {
  return {
    flags: { profileId: '123', changes: JSON.stringify([{ keywordId: '10', bid: 1.5 }]) },
    confirmationState: [{ keywordId: '10', bid: 0.5, state: 'ENABLED', keywordText: 'kw' }],
    progress() {},
    adsClient: {
      async request() {
        if (typeof response === 'function') return response();
        return response;
      },
    },
  };
}

test('execute:网络中断(write_result_unknown)计入 resultUnknown 而非 failed,并提示先核对', async () => {
  const ctx = executeCtx(() => {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'ads.write_result_unknown',
      hintAgent: 'report_to_human',
      hintHuman: 'unknown',
      message: 'socket hang up after dispatch',
    });
  });
  const result = await adsBidBatch.execute(ctx);
  assert.equal(result.failedCount, 0);
  assert.equal(result.resultUnknownCount, 1);
  assert.equal(result.resultUnknown[0].keywordId, '10');
  assert.match(result.result_unknown_note, /不要直接重跑/);
  assert.equal(result.failed, undefined);
});

test('execute:响应形状未知计入 resultUnknown(UNKNOWN_RESPONSE_SHAPE)', async () => {
  const result = await adsBidBatch.execute(executeCtx({}));
  assert.equal(result.failedCount, 0);
  assert.equal(result.resultUnknownCount, 1);
  assert.equal(result.resultUnknown[0].reason, 'UNKNOWN_RESPONSE_SHAPE');
});

test('execute:确定性错误仍计入 failed,不进 resultUnknown', async () => {
  const ctx = executeCtx(() => {
    throw new Error('403 Forbidden');
  });
  const result = await adsBidBatch.execute(ctx);
  assert.equal(result.failedCount, 1);
  assert.equal(result.resultUnknownCount, 0);
  assert.match(result.failed[0].reason, /403/);
});
