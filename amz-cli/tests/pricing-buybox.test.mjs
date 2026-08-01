import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBuyBox, summarizeBuyBox } from '../dist/shortcuts/pricing/buybox.js';

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

test('响应未暴露 sellerId → iWin=null(无法判定归属)', () => {
  const body = summaryWith([{ listingPrice: { amount: 20, currencyCode: 'CAD' } }]);
  const r = extractBuyBox(body, MY);
  assert.equal(r.iWin, null);
  assert.equal(r.status, 'lost'); // 保守:认不出是自己就算没拿到
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
