import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBuyBox, summarizeBuyBox, pricingBuybox } from '../dist/shortcuts/pricing/buybox.js';
import { mapBatchResults } from '../dist/shortcuts/pricing/batch.js';

const MY = 'SELLER_ME';

function summaryWith(offers, buyingOptionType = 'New') {
  return { featuredBuyingOptions: [{ buyingOptionType, segmentedFeaturedOffers: offers }] };
}

test('自己拿着 Buy Box → won,用自己的价', () => {
  const body = summaryWith([{ sellerId: MY, listingPrice: { amount: 19.99, currencyCode: 'CAD' } }]);
  const r = extractBuyBox(body, MY);
  assert.equal(r.status, 'won');
  assert.equal(r.iWin, true);
  assert.equal(r.buyBoxPrice, 19.99);
  assert.equal(r.currency, 'CAD');
});

test('别人拿着 Buy Box → lost', () => {
  const body = summaryWith([{ sellerId: 'SELLER_OTHER', listingPrice: { amount: 18.5, currencyCode: 'CAD' } }]);
  const r = extractBuyBox(body, MY);
  assert.equal(r.status, 'lost');
  assert.equal(r.iWin, false);
  assert.equal(r.buyBoxPrice, 18.5);
});

test('没有 featured offer → no-featured-offer', () => {
  const r = extractBuyBox({ featuredBuyingOptions: [] }, MY);
  assert.equal(r.status, 'no-featured-offer');
  assert.equal(r.hasFeaturedOffer, false);
  assert.equal(r.iWin, false);
});

test('响应未暴露 sellerId → undetermined,iWin=null(不能硬标 lost 触发错误降价)', () => {
  const body = summaryWith([{ listingPrice: { amount: 20, currencyCode: 'CAD' } }]);
  const r = extractBuyBox(body, MY);
  assert.equal(r.iWin, null);
  assert.equal(r.status, 'undetermined');
  assert.equal(r.buyBoxPrice, 20);
});

test('只认 New buyingOptionType;Used 的 featured 不算', () => {
  const body = summaryWith([{ sellerId: MY, listingPrice: { amount: 9, currencyCode: 'CAD' } }], 'Used');
  const r = extractBuyBox(body, MY);
  assert.equal(r.status, 'no-featured-offer');
});

test('summarizeBuyBox:200 抽取、非 200 记 error', () => {
  const rows = summarizeBuyBox(
    [
      { asin: 'B000000001', httpStatus: 200, summary: summaryWith([{ sellerId: MY, listingPrice: { amount: 5, currencyCode: 'USD' } }]) },
      { asin: 'B000000002', httpStatus: 404, error: { code: 'NOT_FOUND' } },
    ],
    MY,
  );
  assert.equal(rows[0].status, 'won');
  assert.equal(rows[1].status, 'error');
  assert.deepEqual(rows[1].error, { code: 'NOT_FOUND' });
});

test('summarizeBuyBox:200 但带 error(标识核对失败的行)也记 error,不误判 no-featured-offer', () => {
  const rows = summarizeBuyBox(
    [{ asin: 'B000000001', httpStatus: 200, error: 'response asin mismatch: expected B000000001, got B000000009' }],
    MY,
  );
  assert.equal(rows[0].status, 'error');
});

// ---- mapBatchResults 一致性校验 ----
test('mapBatchResults 响应条数与请求不一致 → 抛类型化上游错误,整批不可采信', () => {
  assert.throws(
    () => mapBatchResults({ responses: [{ status: { statusCode: 200 }, body: {} }] }, ['B000000001', 'B000000002'], 'asin', 'summary'),
    (e) => e?.subtype === 'pricing.batch_count_mismatch' && e?.type === 'upstream_error',
  );
});

test('mapBatchResults body 自带标识与请求不一致 → 该行标 error,不把数据安到错误的 ASIN 上', () => {
  const out = mapBatchResults(
    {
      responses: [
        { status: { statusCode: 200 }, body: { asin: 'B000000001', x: 1 } }, // 一致,正常收
        { status: { statusCode: 200 }, body: { asin: 'B000000009', x: 2 } }, // 不一致,标错
      ],
    },
    ['B000000001', 'B000000002'],
    'asin',
    'summary',
  );
  assert.deepEqual(out[0].summary, { asin: 'B000000001', x: 1 });
  assert.equal(out[1].summary, undefined);
  assert.match(String(out[1].error), /mismatch/);
});

test('mapBatchResults body 无标识字段时按下标配对(条数一致的前提下)', () => {
  const out = mapBatchResults(
    { responses: [{ status: { statusCode: 200 }, body: { x: 1 } }, { status: { statusCode: 500 }, body: { code: 'ERR' } }] },
    ['SKU-A', 'SKU-B'],
    'sku',
    'result',
  );
  assert.deepEqual(out[0].result, { x: 1 });
  assert.deepEqual(out[1].error, { code: 'ERR' });
});

// ---- counts 各状态互斥 ----
test('pricing buybox counts 各状态互斥:won+lost+undetermined+noFeaturedOffer+errors === total', async () => {
  const bodies = [
    summaryWith([{ sellerId: MY, listingPrice: { amount: 5, currencyCode: 'USD' } }]), // won
    summaryWith([{ sellerId: 'SELLER_OTHER', listingPrice: { amount: 6, currencyCode: 'USD' } }]), // lost
    summaryWith([{ listingPrice: { amount: 7, currencyCode: 'USD' } }]), // undetermined(无 sellerId)
    { featuredBuyingOptions: [] }, // no-featured-offer
  ];
  const asins = ['B000000001', 'B000000002', 'B000000003', 'B000000004', 'B000000005'];
  const ctx = {
    flags: { marketplace: 'US', asins: asins.join(','), sellerId: MY },
    progress() {},
    client: {
      async request() {
        return {
          responses: [
            ...bodies.map((b, i) => ({ status: { statusCode: 200 }, body: { asin: asins[i], ...b } })),
            { status: { statusCode: 500 }, body: { code: 'BOOM' } }, // error
          ],
        };
      },
    },
  };
  const result = await pricingBuybox.execute(ctx);
  assert.deepEqual(result.counts, {
    total: 5,
    won: 1,
    lost: 1,
    undetermined: 1,
    noFeaturedOffer: 1,
    errors: 1,
  });
  const c = result.counts;
  assert.equal(c.won + c.lost + c.undetermined + c.noFeaturedOffer + c.errors, c.total);
});
