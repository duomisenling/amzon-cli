import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listingUpdate } from '../dist/shortcuts/listing/update.js';

afterEach(() => {
  delete process.env.SELLER_ID;
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
