import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listingMine, resolveUniqueListingSku } from '../dist/shortcuts/listing/mine.js';

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
  assert.deepEqual(result.asinSkuMatches, [
    { asin: 'B0H2TYPC26', skus: ['SKU-A', 'SKU-B'], status: 'AMBIGUOUS' },
  ]);
  assert.deepEqual(result.unmatchedAsins, []);
  assert.deepEqual(result.ambiguousAsins, [{ asin: 'B0H2TYPC26', skus: ['SKU-A', 'SKU-B'] }]);
});

test('listing mine maps a batch of ASINs to unique, missing, and ambiguous SKUs', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx, calls } = contextWith([
    { sku: 'SKU-A', summaries: [{ asin: 'B0AAAAAAAA' }] },
    { sku: 'SKU-B1', summaries: [{ asin: 'B0BBBBBBBB' }] },
    { sku: 'SKU-B2', summaries: [{ asin: 'B0BBBBBBBB' }] },
  ]);
  ctx.flags = { marketplace: 'FR', asin: 'B0AAAAAAAA,B0BBBBBBBB,B0CCCCCCCC' };

  const result = await listingMine.execute(ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.identifiers, 'B0AAAAAAAA,B0BBBBBBBB,B0CCCCCCCC');
  assert.deepEqual(result.asinSkuMatches, [
    { asin: 'B0AAAAAAAA', skus: ['SKU-A'], status: 'UNIQUE' },
    { asin: 'B0BBBBBBBB', skus: ['SKU-B1', 'SKU-B2'], status: 'AMBIGUOUS' },
    { asin: 'B0CCCCCCCC', skus: [], status: 'NOT_FOUND' },
  ]);
  assert.deepEqual(result.unmatchedAsins, ['B0CCCCCCCC']);
  assert.deepEqual(result.ambiguousAsins, [{ asin: 'B0BBBBBBBB', skus: ['SKU-B1', 'SKU-B2'] }]);
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.paginationComplete, true);
});

test('listing mine --asin automatically fetches every page before mapping SKUs', async () => {
  process.env.SELLER_ID = 'SELLER';
  const calls = [];
  const pages = {
    first: {
      numberOfResults: 3,
      items: [{ sku: 'SKU-A', summaries: [{ asin: 'B0AAAAAAAA' }] }],
      pagination: { nextToken: 'TOKEN-2' },
    },
    'TOKEN-2': {
      numberOfResults: 3,
      items: [{ sku: 'SKU-B', summaries: [{ asin: 'B0BBBBBBBB' }] }],
      pagination: { nextToken: 'TOKEN-3' },
    },
    'TOKEN-3': {
      numberOfResults: 3,
      items: [{ sku: 'SKU-C', summaries: [{ asin: 'B0CCCCCCCC' }] }],
    },
  };
  const ctx = {
    flags: { marketplace: 'US', asin: 'B0AAAAAAAA,B0BBBBBBBB,B0CCCCCCCC' },
    progress() {},
    client: {
      async get(path, query, region) {
        calls.push({ path, query, region });
        return pages[query.pageToken ?? 'first'];
      },
    },
  };

  const result = await listingMine.execute(ctx);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.query.pageToken), [undefined, 'TOKEN-2', 'TOKEN-3']);
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.nextToken, undefined);
  assert.deepEqual(result.unmatchedAsins, []);
  assert.deepEqual(result.matchedSkus, ['SKU-A', 'SKU-B', 'SKU-C']);
});

test('listing mine with an explicit page token remains a single-page request', async () => {
  process.env.SELLER_ID = 'SELLER';
  const calls = [];
  const ctx = {
    flags: { marketplace: 'US', asin: 'B0AAAAAAAA', pageToken: 'TOKEN-2' },
    progress() {},
    client: {
      async get(path, query, region) {
        calls.push({ path, query, region });
        return {
          numberOfResults: 2,
          items: [{ sku: 'SKU-A', summaries: [{ asin: 'B0AAAAAAAA' }] }],
          pagination: { nextToken: 'TOKEN-3' },
        };
      },
    },
  };

  const result = await listingMine.execute(ctx);

  assert.equal(calls.length, 1);
  assert.equal(result.pagesFetched, undefined);
  assert.equal(result.paginationComplete, undefined);
  assert.equal(result.nextToken, 'TOKEN-3');
});

test('listing mine stops when the API repeats an ASIN pagination token', async () => {
  process.env.SELLER_ID = 'SELLER';
  let calls = 0;
  const ctx = {
    flags: { marketplace: 'US', asin: 'B0AAAAAAAA' },
    progress() {},
    client: {
      async get() {
        calls += 1;
        return { numberOfResults: 2, items: [], pagination: { nextToken: 'SAME' } };
      },
    },
  };

  await assert.rejects(
    () => listingMine.execute(ctx),
    (error) => error?.subtype === 'listing.pagination_token_loop',
  );
  assert.equal(calls, 2);
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

test('resolveUniqueListingSku:ASIN 对应 SKU 超一页(numberOfResults > 返回条数)时报错,不误判唯一', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    sku: `SKU-${i}`,
    summaries: [{ asin: 'B0AAAAAAAA' }],
  }));
  const client = {
    async get() {
      // 共 25 条,但一页只回 20 条:剩下 5 条里可能还有别的 SKU,不能当作已看全
      return { numberOfResults: 25, items };
    },
  };
  await assert.rejects(
    () => resolveUniqueListingSku({ marketplace: 'US', asin: 'B0AAAAAAAA', sellerId: 'SELLER' }, client),
    (error) => error?.subtype === 'listing.asin_too_many_skus',
  );
});

test('resolveUniqueListingSku:numberOfResults 与返回条数一致时维持原判定(多匹配仍报 ambiguous)', async () => {
  const client = {
    async get() {
      return {
        numberOfResults: 2,
        items: [
          { sku: 'SKU-A', summaries: [{ asin: 'B0AAAAAAAA' }] },
          { sku: 'SKU-B', summaries: [{ asin: 'B0AAAAAAAA' }] },
        ],
      };
    },
  };
  await assert.rejects(
    () => resolveUniqueListingSku({ marketplace: 'US', asin: 'B0AAAAAAAA', sellerId: 'SELLER' }, client),
    (error) => error?.subtype === 'listing.asin_ambiguous',
  );
});
