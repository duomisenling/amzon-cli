import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
