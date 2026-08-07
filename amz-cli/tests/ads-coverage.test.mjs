import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmzError } from '../dist/internal/errs/errors.js';
import { adsProductAds, extractAdCoverage } from '../dist/shortcuts/ads/product-ads.js';

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

test('product-ads 自动翻页合并各页,并把 nextToken 传给下一页请求', async () => {
  const calls = [];
  const ctx = {
    flags: { profileId: '123' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        calls.push({ method, path, opts });
        if (calls.length === 1) return { productAds: [{ adId: 'a1' }], nextToken: 'p2' };
        return { productAds: [{ adId: 'a2' }] };
      },
    },
  };
  const result = await adsProductAds.execute(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.body.nextToken, undefined);
  assert.equal(calls[1].opts.body.nextToken, 'p2');
  assert.equal(result.count, 2);
});

test('product-ads nextToken 死循环时 100 页熔断,不无限拉取', async () => {
  let calls = 0;
  const ctx = {
    flags: { profileId: '123' },
    progress() {},
    adsClient: {
      async request() {
        calls += 1;
        return { productAds: [], nextToken: 'again' };
      },
    },
  };
  await assert.rejects(
    adsProductAds.execute(ctx),
    (error) => error instanceof AmzError && error.subtype === 'ads.product_ads_pagination_limit',
  );
  assert.equal(calls, 100);
});
