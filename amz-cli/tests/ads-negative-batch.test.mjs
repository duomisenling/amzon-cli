import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseNegativeChanges,
  buildNegativeKeywordsBody,
  MAX_NEGATIVE_BATCH,
} from '../dist/shortcuts/ads/negative-batch.js';

test('parseNegativeChanges 规范化:默认精准否定、排序、match 大小写不敏感', () => {
  const out = parseNegativeChanges([
    { campaignId: '2', adGroupId: '9', text: 'Zed' },
    { campaignId: 1, adGroupId: 5, text: 'apple', match: 'negative_phrase' },
  ]);
  assert.deepEqual(out, [
    { campaignId: '1', adGroupId: '5', text: 'apple', match: 'NEGATIVE_PHRASE' },
    { campaignId: '2', adGroupId: '9', text: 'Zed', match: 'NEGATIVE_EXACT' },
  ]);
});

test('parseNegativeChanges 拒绝非数组/空/超量', () => {
  assert.throws(() => parseNegativeChanges('x'), /must be a JSON array/);
  assert.throws(() => parseNegativeChanges([]), /empty/);
  const tooMany = Array.from({ length: MAX_NEGATIVE_BATCH + 1 }, (_, i) => ({
    campaignId: '1',
    adGroupId: '2',
    text: `t${i}`,
  }));
  assert.throws(() => parseNegativeChanges(tooMany), /exceed max/);
});

test('parseNegativeChanges 校验字段与去重', () => {
  assert.throws(() => parseNegativeChanges([{ campaignId: 'x', adGroupId: '2', text: 'a' }]), /invalid campaignId/);
  assert.throws(() => parseNegativeChanges([{ campaignId: '1', adGroupId: 'y', text: 'a' }]), /invalid adGroupId/);
  assert.throws(() => parseNegativeChanges([{ campaignId: '1', adGroupId: '2', text: '   ' }]), /empty/);
  assert.throws(() => parseNegativeChanges([{ campaignId: '1', adGroupId: '2', text: 'a', match: 'FOO' }]), /invalid match/);
  assert.throws(
    () =>
      parseNegativeChanges([
        { campaignId: '1', adGroupId: '2', text: 'Dog' },
        { campaignId: '1', adGroupId: '2', text: 'dog' }, // 同活动/组/匹配、大小写不同视为重复
      ]),
    /duplicate/,
  );
});

test('去重按 campaign+adGroup+match+text:不同广告组同词不算重复', () => {
  const out = parseNegativeChanges([
    { campaignId: '1', adGroupId: '2', text: 'dog' },
    { campaignId: '1', adGroupId: '3', text: 'dog' },
  ]);
  assert.equal(out.length, 2);
});

test('buildNegativeKeywordsBody 组装提交体(state=ENABLED)', () => {
  const body = buildNegativeKeywordsBody([{ campaignId: '1', adGroupId: '2', text: 'dog', match: 'NEGATIVE_EXACT' }]);
  assert.deepEqual(body, {
    negativeKeywords: [
      { campaignId: '1', adGroupId: '2', keywordText: 'dog', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
    ],
  });
});
