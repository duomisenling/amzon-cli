import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsCampaigns } from '../dist/shortcuts/ads/commands.js';
import { adsKeywords } from '../dist/shortcuts/ads/keywords.js';

/** 每次调用按顺序吐 pages 里的响应,并记录全部请求。 */
function pagedContext(flags, pages) {
  const requests = [];
  let i = 0;
  return {
    ctx: {
      flags,
      progress() {},
      adsClient: {
        async request(method, path, options) {
          requests.push({ method, path, options });
          return pages[Math.min(i++, pages.length - 1)];
        },
      },
    },
    requests,
  };
}

test('ads campaigns:满页即停,透传起始 nextToken 并暴露后续游标', async () => {
  const page = {
    campaigns: Array.from({ length: 25 }, (_, k) => ({ campaignId: String(k) })),
    nextToken: 'page-3',
  };
  const { ctx, requests } = pagedContext({ profileId: '123', max: '25', nextToken: 'page-2' }, [page]);
  const result = await adsCampaigns.execute(ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body.nextToken, 'page-2');
  assert.equal(requests[0].options.body.maxResults, 25);
  assert.equal(result.count, 25);
  assert.equal(result.nextToken, 'page-3');
});

test('ads campaigns:--max 250 自动翻页拼接(100+100+50),游标链式传递', async () => {
  const mk = (n, base, token) => ({
    campaigns: Array.from({ length: n }, (_, k) => ({ campaignId: String(base + k) })),
    ...(token ? { nextToken: token } : {}),
  });
  const { ctx, requests } = pagedContext({ profileId: '123', max: '250' }, [
    mk(100, 0, 't1'),
    mk(100, 100, 't2'),
    mk(50, 200, 't3'),
  ]);
  const result = await adsCampaigns.execute(ctx);
  assert.equal(result.count, 250);
  assert.deepEqual(requests.map((r) => r.options.body.maxResults), [100, 100, 50]);
  assert.equal(requests[0].options.body.nextToken, undefined);
  assert.equal(requests[1].options.body.nextToken, 't1');
  assert.equal(requests[2].options.body.nextToken, 't2');
  // 凑满 250 就停,还有更多时把游标暴露出去
  assert.equal(result.nextToken, 't3');
});

test('ads campaigns:--max 500 现在合法(自动翻页),超过 10000 仍拦', () => {
  adsCampaigns.validate({ profileId: '123', max: '500' });
  assert.throws(
    () => adsCampaigns.validate({ profileId: '123', max: '20000' }),
    (error) => error?.subtype === 'invalid_number',
  );
});

test('ads campaigns:服务端给 nextToken 但回空页时停止,不死循环', async () => {
  const { ctx, requests } = pagedContext({ profileId: '123', max: '300' }, [
    { campaigns: [{ campaignId: '1' }], nextToken: 'more' },
    { campaigns: [], nextToken: 'more' },
  ]);
  const result = await adsCampaigns.execute(ctx);
  assert.equal(requests.length, 2);
  assert.equal(result.count, 1);
});

test('ads campaigns:--campaign-id 逗号分隔转成 campaignIdFilter,非法 ID 本地拦下', async () => {
  assert.throws(
    () => adsCampaigns.validate({ profileId: '123', campaignId: '111,abc' }),
    (error) => error?.subtype === 'ads.invalid_campaign_id',
  );
  const { ctx, requests } = pagedContext(
    { profileId: '123', campaignId: '111111111111111, 222222222222222' },
    [{ campaigns: [{ campaignId: '111111111111111' }] }],
  );
  const result = await adsCampaigns.execute(ctx);
  assert.deepEqual(requests[0].options.body.campaignIdFilter, {
    include: ['111111111111111', '222222222222222'],
  });
  assert.equal(result.count, 1);
});

test('ads keywords:--campaign-id 支持逗号分隔多个活动', async () => {
  const { ctx, requests } = pagedContext({ profileId: '123', campaignId: '1,2' }, [{ keywords: [] }]);
  await adsKeywords.execute(ctx);
  assert.deepEqual(requests[0].options.body.campaignIdFilter, { include: ['1', '2'] });
});

test('ads keywords:多页自动拼接并做字段裁剪,非法 --max 本地拦下', async () => {
  assert.throws(
    () => adsKeywords.validate({ profileId: '123', max: 'NaN' }),
    (error) => error?.subtype === 'invalid_number',
  );
  const mk = (n, base, token) => ({
    keywords: Array.from({ length: n }, (_, k) => ({
      keywordId: String(base + k),
      keywordText: 'kw',
      matchType: 'EXACT',
      bid: 1,
      state: 'ENABLED',
      campaignId: 'c1',
      adGroupId: 'g1',
    })),
    ...(token ? { nextToken: token } : {}),
  });
  const { ctx, requests } = pagedContext({ profileId: '123', max: '150', nextToken: 'page-2' }, [
    mk(100, 0, 't1'),
    mk(50, 100, undefined),
  ]);
  const result = await adsKeywords.execute(ctx);
  assert.equal(result.count, 150);
  assert.equal(requests[0].options.body.nextToken, 'page-2');
  assert.equal(requests[1].options.body.nextToken, 't1');
  assert.deepEqual(requests.map((r) => r.options.body.maxResults), [100, 50]);
  assert.equal(result.nextToken, undefined);
  assert.equal(result.keywords[0].text, 'kw');
});
