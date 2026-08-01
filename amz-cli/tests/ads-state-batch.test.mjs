import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
