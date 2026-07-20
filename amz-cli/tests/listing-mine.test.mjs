import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listingMine } from '../dist/shortcuts/listing/mine.js';

afterEach(() => {
  delete process.env.SELLER_ID;
});

function contextWith(items) {
  const calls = [];
  return {
    calls,
    ctx: {
      flags: {},
      progress() {},
      client: {
        async get(path, query, region) {
          calls.push({ path, query, region });
          return { numberOfResults: items.length, items };
        },
      },
    },
  };
}

test('listing mine --asin queries by ASIN and surfaces the matched store SKUs', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx, calls } = contextWith([
    { sku: 'SKU-A', summaries: [{ asin: 'B0H2TYPC26' }] },
    { sku: 'SKU-B', summaries: [{ asin: 'B0H2TYPC26' }] },
  ]);
  ctx.flags = { marketplace: 'DE', asin: 'B0H2TYPC26' };

  const result = await listingMine.execute(ctx);
  assert.equal(calls[0].query.identifiersType, 'ASIN');
  assert.equal(calls[0].query.identifiers, 'B0H2TYPC26');
  assert.deepEqual(result.matchedSkus, ['SKU-A', 'SKU-B']);
});

test('listing mine --skus keeps SKU identifiersType and omits matchedSkus', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx, calls } = contextWith([{ sku: 'SKU-A' }]);
  ctx.flags = { marketplace: 'US', skus: 'SKU-A' };

  const result = await listingMine.execute(ctx);
  assert.equal(calls[0].query.identifiersType, 'SKU');
  assert.equal(result.matchedSkus, undefined);
});

test('listing mine rejects --skus and --asin used together', () => {
  assert.throws(
    () => listingMine.validate({ marketplace: 'US', skus: 'SKU-A', asin: 'B0H2TYPC26' }),
    (error) => error?.subtype === 'conflicting_identifiers',
  );
});

test('listing mine rejects more than 20 ASINs', () => {
  const asins = Array.from({ length: 21 }, (_, i) => `B0${i}`).join(',');
  assert.throws(
    () => listingMine.validate({ marketplace: 'US', asin: asins }),
    (error) => error?.subtype === 'invalid_identifier_count',
  );
});
