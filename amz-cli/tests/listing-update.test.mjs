import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listingUpdate } from '../dist/shortcuts/listing/update.js';
import { resolveSellerId } from '../dist/shortcuts/listing/mine.js';

afterEach(() => {
  delete process.env.SELLER_ID;
  delete process.env.SELLER_ID_NA;
  delete process.env.BROKER_URL;
  delete process.env.SP_API_SANDBOX;
});

function flags(patches) {
  return {
    marketplace: 'US',
    sku: 'SKU-1',
    productType: 'PRODUCT',
    patches: JSON.stringify(patches),
  };
}

function context(patches, validation) {
  const requests = [];
  return {
    requests,
    ctx: {
      flags: flags(patches),
      progress: () => {},
      client: {
        get: async () => ({ attributes: {} }),
        request: async (method, path, opts) => {
          requests.push({ method, path, opts });
          return validation;
        },
      },
    },
  };
}

test('accepts the official top-level patch shape', () => {
  assert.doesNotThrow(() =>
    listingUpdate.validate(flags([
      { op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] },
    ])),
  );
});

test('rejects unsupported operations, nested paths, and non-array values locally', () => {
  assert.throws(
    () => listingUpdate.validate(flags([{ op: 'move', path: '/attributes/item_name' }])),
    (error) => error?.subtype === 'invalid_patch_operation',
  );
  assert.throws(
    () => listingUpdate.validate(flags([{ op: 'replace', path: '/attributes/item_name/0/value', value: [] }])),
    (error) => error?.subtype === 'invalid_patch_path',
  );
  assert.throws(
    () => listingUpdate.validate(flags([{ op: 'replace', path: '/attributes/item_name', value: 'bad' }])),
    (error) => error?.subtype === 'invalid_patch_value',
  );
});

test('add, replace, and merge require value before any Amazon preview call', () => {
  for (const [op, path] of [
    ['add', '/attributes/item_name'],
    ['replace', '/attributes/item_name'],
    ['merge', '/attributes/fulfillment_availability'],
  ]) {
    assert.throws(
      () => listingUpdate.validate(flags([{ op, path }])),
      (error) => error?.subtype === 'missing_patch_value',
      `${op} without value should be rejected`,
    );
  }
});

test('merge only accepts the two paths documented by Amazon', () => {
  for (const path of [
    '/attributes/fulfillment_availability',
    '/attributes/purchasable_offer',
  ]) {
    assert.doesNotThrow(() =>
      listingUpdate.validate(flags([{ op: 'merge', path, value: [{}] }])),
    );
  }
  assert.throws(
    () => listingUpdate.validate(flags([
      { op: 'merge', path: '/attributes/item_name', value: [{ value: 'New name' }] },
    ])),
    (error) => error?.subtype === 'unsupported_merge_path',
  );
});

test('delete remains schema-driven and is not forced to include value locally', () => {
  assert.doesNotThrow(() =>
    listingUpdate.validate(flags([{ op: 'delete', path: '/attributes/item_name' }])),
  );
});

test('local mode keeps explicit and region Seller ID precedence without credential lookup', async () => {
  process.env.SELLER_ID = 'DEFAULT_SELLER';
  process.env.SELLER_ID_NA = 'REGION_SELLER';
  let credentialLookups = 0;
  const client = {
    getSellerId: async () => {
      credentialLookups += 1;
      return 'SHOULD_NOT_BE_USED';
    },
  };
  assert.equal(await resolveSellerId({}, 'na', client), 'REGION_SELLER');
  assert.equal(await resolveSellerId({ sellerId: 'EXPLICIT_SELLER' }, 'na', client), 'EXPLICIT_SELLER');
  assert.equal(credentialLookups, 0);
});

test('local mode missing Seller ID fails without requesting LWA credentials', async () => {
  let credentialLookups = 0;
  await assert.rejects(
    () => resolveSellerId({}, 'na', {
      getSellerId: async () => {
        credentialLookups += 1;
        return undefined;
      },
    }),
    (error) => error?.subtype === 'missing_seller_id',
  );
  assert.equal(credentialLookups, 0);
});

test('Broker Seller ID remains authoritative and explicit flag is not a fallback', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  let brokerLookups = 0;
  await assert.rejects(
    () => resolveSellerId({ sellerId: 'EXPLICIT_SELLER' }, 'na', {
      getSellerId: async () => {
        brokerLookups += 1;
        return undefined;
      },
    }),
    (error) => error?.subtype === 'missing_seller_id',
  );
  assert.equal(brokerLookups, 1);
});

test('INVALID validation preview fails before the framework can issue a token', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx } = context(
    [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }],
    { status: 'INVALID', issues: [{ severity: 'ERROR', code: '90000900' }] },
  );

  await assert.rejects(
    () => listingUpdate.dryRun(ctx),
    (error) => error?.subtype === 'listing.validation_failed',
  );
});

test('VALID status with an ERROR issue is still rejected', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx } = context(
    [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }],
    { status: 'VALID', issues: [{ severity: 'ERROR', code: 'EXAMPLE' }] },
  );

  await assert.rejects(
    () => listingUpdate.dryRun(ctx),
    (error) => error?.subtype === 'listing.validation_failed',
  );
});

test('successful preview uses VALIDATION_PREVIEW and requests identifiers', async () => {
  process.env.SELLER_ID = 'SELLER';
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const { ctx, requests } = context(patches, { status: 'VALID', issues: [] });

  await listingUpdate.dryRun(ctx);
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /includedData=identifiers%2Cissues/);
  assert.match(requests[0].path, /mode=VALIDATION_PREVIEW/);
});

test('formal submission omits preview-only mode and identifiers', async () => {
  process.env.SELLER_ID = 'SELLER';
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const { ctx, requests } = context(patches, { status: 'ACCEPTED', issues: [] });
  ctx.confirmedInput = patches;

  await listingUpdate.execute(ctx);
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /includedData=issues/);
  assert.doesNotMatch(requests[0].path, /identifiers|VALIDATION_PREVIEW/);
});

test('Broker seller ID is authoritative and rejects an explicit mismatch', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  process.env.SELLER_ID = 'STALE_LOCAL_SELLER';
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const { ctx } = context(patches, { status: 'VALID', issues: [] });
  ctx.client.getSellerId = async () => 'BROKER_SELLER';
  ctx.flags.sellerId = 'WRONG_SELLER';

  await assert.rejects(
    () => listingUpdate.dryRun(ctx),
    (error) => error?.subtype === 'broker.seller_id_mismatch',
  );
});

test('confirmation snapshot binds the Seller ID resolved from Broker', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const { ctx } = context(patches, { status: 'VALID', issues: [] });
  ctx.client.getSellerId = async () => 'BROKER_SELLER';

  const snapshot = await listingUpdate.confirmationRuntimeSnapshot(ctx);
  assert.deepEqual(snapshot, {
    sellerId: 'BROKER_SELLER',
    region: 'na',
    marketplaceId: 'ATVPDKIKX0DER',
  });
});
