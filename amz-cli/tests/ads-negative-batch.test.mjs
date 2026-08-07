import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmzError } from '../dist/internal/errs/errors.js';
import {
  adsNegativeBatch,
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

function executeCtx(respond) {
  return {
    flags: {
      profileId: '123',
      changes: JSON.stringify([{ campaignId: '1', adGroupId: '2', text: 'bad term' }]),
    },
    progress() {},
    adsClient: { request: respond },
  };
}

test('execute:网络中断(write_result_unknown)计入结果不明,提示不要重跑以免重复否定词', async () => {
  const ctx = executeCtx(async () => {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'ads.write_result_unknown',
      hintAgent: 'report_to_human',
      hintHuman: 'unknown',
      message: 'socket hang up after dispatch',
    });
  });
  const result = await adsNegativeBatch.execute(ctx);
  assert.equal(result.failedCount, 0);
  assert.equal(result.resultUnknownCount, 1);
  assert.equal(result.resultUnknownChunks.length, 1);
  assert.equal(result.failedChunks, undefined);
  assert.match(result.note, /不要直接重跑/);
  assert.match(result.note, /重复否定词/);
});

test('execute:响应结构未识别同样计入结果不明(unknownResponseCount)', async () => {
  const result = await adsNegativeBatch.execute(executeCtx(async () => ({})));
  assert.equal(result.failedCount, 0);
  assert.equal(result.resultUnknownCount, 1);
  assert.equal(result.unknownResponseCount, 1);
  assert.match(result.note, /不要直接重跑/);
});

test('execute:确定性错误仍计入 failedChunks,不进结果不明', async () => {
  const result = await adsNegativeBatch.execute(
    executeCtx(async () => {
      throw new Error('403 Forbidden');
    }),
  );
  assert.equal(result.failedCount, 1);
  assert.equal(result.resultUnknownCount, 0);
  assert.match(result.failedChunks[0].reason, /403/);
  assert.match(result.note, /不要自动重试/);
});
