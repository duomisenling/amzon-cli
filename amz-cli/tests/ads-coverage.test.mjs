import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAdCoverage } from '../dist/shortcuts/ads/product-ads.js';

const ads = [
  { adId: 'a1', campaignId: 'c1', adGroupId: 'g1', sku: 'SKU-A', state: 'ENABLED' },
  { adId: 'a2', campaignId: 'c1', adGroupId: 'g1', asin: 'B0BBBBBBBB', state: 'PAUSED' },
  { adId: 'a3', campaignId: 'c2', adGroupId: 'g2', sku: 'SKU-C', state: 'ARCHIVED' }, // 默认排除
];

test('extractAdCoverage 抽取字段,默认可接受 ENABLED/PAUSED,排除 ARCHIVED', () => {
  const rows = extractAdCoverage(ads, ['ENABLED', 'PAUSED']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { asin: undefined, sku: 'SKU-A', adId: 'a1', adGroupId: 'g1', campaignId: 'c1', state: 'ENABLED' });
  assert.equal(rows[1].asin, 'B0BBBBBBBB');
  assert.equal(rows.find((r) => r.adId === 'a3'), undefined);
});

test('extractAdCoverage 空 acceptedStates = 不过滤,全保留', () => {
  const rows = extractAdCoverage(ads, []);
  assert.equal(rows.length, 3);
});

test('extractAdCoverage 状态匹配大小写不敏感', () => {
  const rows = extractAdCoverage(ads, ['enabled']);
  assert.deepEqual(rows.map((r) => r.adId), ['a1']);
});

test('extractAdCoverage 缺字段时安全返回 undefined', () => {
  const rows = extractAdCoverage([{ state: 'ENABLED' }], ['ENABLED']);
  assert.deepEqual(rows[0], { asin: undefined, sku: undefined, adId: undefined, adGroupId: undefined, campaignId: undefined, state: 'ENABLED' });
});
