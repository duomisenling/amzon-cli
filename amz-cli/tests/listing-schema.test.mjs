import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { listingSchema } from '../dist/shortcuts/listing/schema.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SELLER_ID;
});

function checksum(buf) {
  return createHash('md5').update(buf).digest('base64');
}

test('listing schema requests a seller-specific partial-update definition and verifies content', async () => {
  process.env.SELLER_ID = 'SELLER_US';
  const schemaBytes = Buffer.from(JSON.stringify({
    properties: { item_name: { type: 'array' }, bullet_point: { type: 'array' } },
    required: [],
  }));
  globalThis.fetch = async () => new Response(schemaBytes, { status: 200 });
  let query;
  const ctx = {
    flags: { marketplace: 'US', productType: 'PRODUCT', grep: 'item' },
    progress: () => {},
    client: {
      get: async (_path, incomingQuery) => {
        query = incomingQuery;
        return {
          productType: 'PRODUCT',
          requirementsEnforced: 'NOT_ENFORCED',
          schema: {
            link: { resource: 'https://schema.example.test/product.json' },
            checksum: checksum(schemaBytes),
          },
        };
      },
    },
  };

  const result = await listingSchema.execute(ctx);
  assert.equal(query.sellerId, 'SELLER_US');
  assert.equal(query.productTypeVersion, 'LATEST');
  assert.equal(query.requirements, 'LISTING');
  assert.equal(query.requirementsEnforced, 'NOT_ENFORCED');
  assert.deepEqual(result.attributes, ['item_name']);
});

test('listing schema rejects downloaded content whose MD5 does not match Amazon checksum', async () => {
  process.env.SELLER_ID = 'SELLER_US';
  globalThis.fetch = async () => new Response('{"properties":{}}', { status: 200 });
  const ctx = {
    flags: { marketplace: 'US', productType: 'PRODUCT' },
    progress: () => {},
    client: {
      get: async () => ({
        schema: {
          link: { resource: 'https://schema.example.test/product.json' },
          checksum: checksum(Buffer.from('different content')),
        },
      }),
    },
  };

  await assert.rejects(
    () => listingSchema.execute(ctx),
    (error) => error?.subtype === 'schema.checksum_mismatch',
  );
});
