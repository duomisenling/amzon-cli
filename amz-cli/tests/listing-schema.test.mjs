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

async function executeWithSchema(schema, flags) {
  process.env.SELLER_ID = 'SELLER_US';
  const schemaBytes = Buffer.from(JSON.stringify(schema));
  globalThis.fetch = async () => new Response(schemaBytes, { status: 200 });
  return listingSchema.execute({
    flags: { marketplace: 'US', productType: 'STORAGE_RACK', ...flags },
    progress: () => {},
    client: {
      get: async () => ({
        productType: 'STORAGE_RACK',
        schema: {
          link: { resource: 'https://schema.example.test/storage-rack.json' },
          checksum: checksum(schemaBytes),
        },
      }),
    },
  });
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

test('listing schema grep finds Item Highlight by definition title when attribute name differs', async () => {
  const titleDifferentiation = {
    title: 'Item Highlight',
    description:
      'Provide product features or benefit driven phrases, not a full sentence. Information will appear only when the item name is under 75 characters.',
    type: 'array',
    maxUniqueItems: 1,
    items: {
      properties: {
        value: { type: 'string', maxLength: 125, examples: ['Breathable material'] },
      },
    },
  };
  const result = await executeWithSchema({
    properties: {
      bullet_point: { title: 'Bullet Point', type: 'array' },
      title_differentiation: titleDifferentiation,
    },
  }, { grep: 'HIGHLIGHT' });

  assert.deepEqual(result.attributes, ['title_differentiation']);
  assert.equal(result.matched, 1);
  assert.equal(result.matches[0].attribute, 'title_differentiation');
  assert.equal(result.matches[0].title, 'Item Highlight');
  assert.equal(result.matches[0].description, titleDifferentiation.description);
  assert.deepEqual(result.matches[0].matchedPaths, [
    'properties.title_differentiation.title',
  ]);
  assert.equal(result.matches[0].matchedText[0].value, 'Item Highlight');
});

test('listing schema grep searches nested string values but not metadata key names', async () => {
  const schema = {
    properties: {
      bullet_point: {
        title: 'Bullet Point',
        description: 'Describe product benefits clearly.',
        items: { examples: ['Easy assembly'] },
      },
      item_name: {
        title: 'Item Name',
        description: 'A concise product name.',
      },
    },
  };

  const descriptionMatch = await executeWithSchema(schema, { grep: 'PRODUCT BENEFITS' });
  assert.deepEqual(descriptionMatch.attributes, ['bullet_point']);
  assert.deepEqual(descriptionMatch.matches[0].matchedPaths, [
    'properties.bullet_point.description',
  ]);

  const nestedExampleMatch = await executeWithSchema(schema, { grep: 'assembly' });
  assert.deepEqual(nestedExampleMatch.attributes, ['bullet_point']);
  assert.deepEqual(nestedExampleMatch.matches[0].matchedPaths, [
    'properties.bullet_point.items.examples[0]',
  ]);

  const metadataKeyOnly = await executeWithSchema(schema, { grep: 'description' });
  assert.deepEqual(metadataKeyOnly.attributes, []);
  assert.deepEqual(metadataKeyOnly.matches, []);
});

test('listing schema attribute lookup still returns the complete definition unchanged', async () => {
  const definition = {
    title: 'Item Highlight',
    type: 'array',
    items: { properties: { value: { type: 'string', maxLength: 125 } } },
  };
  const result = await executeWithSchema({
    properties: { title_differentiation: definition },
  }, { attribute: 'title_differentiation' });

  assert.equal(result.attribute, 'title_differentiation');
  assert.deepEqual(result.definition, definition);
});

test('listing schema grep caps verbose metadata matches per attribute', async () => {
  const result = await executeWithSchema({
    properties: {
      verbose_attribute: {
        examples: Array.from({ length: 25 }, (_, index) => `common example ${index}`),
      },
    },
  }, { grep: 'common' });

  assert.deepEqual(result.attributes, ['verbose_attribute']);
  assert.equal(result.matches[0].matchedText.length, 20);
  assert.equal(result.matches[0].matchedPaths.length, 20);
  assert.equal(result.matches[0].matchedTextTruncated, true);
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
