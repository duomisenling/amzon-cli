import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listingUpdate } from '../dist/shortcuts/listing/update.js';
import { resolveSellerId, resolveUniqueListingSku } from '../dist/shortcuts/listing/mine.js';

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
      confirmationState: {
        currentValues: {},
        schemaEvidence: {
          sellerId: 'SELLER',
          marketplaceId: 'ATVPDKIKX0DER',
          productType: 'PRODUCT',
          version: '1.0',
          checksum: 'test-checksum',
          requirementsEnforced: 'NOT_ENFORCED',
          attributes: Object.fromEntries(
            patches.map((patch) => [
              patch.path.split('/')[2],
              { exists: true, editable: true },
            ]),
          ),
        },
      },
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

test('listing update accepts SKU, ASIN, or both, but never neither', () => {
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const byAsin = flags(patches);
  delete byAsin.sku;
  byAsin.asin = 'B012345678';
  assert.doesNotThrow(() => listingUpdate.validate(byAsin));

  const crossChecked = flags(patches);
  crossChecked.asin = 'B012345678';
  assert.doesNotThrow(() => listingUpdate.validate(crossChecked));

  const missing = flags(patches);
  delete missing.sku;
  assert.throws(
    () => listingUpdate.validate(missing),
    (error) => error?.subtype === 'listing.missing_identifier',
  );
});

test('ASIN resolution requires a unique store SKU and cross-checks an explicit SKU', async () => {
  process.env.SELLER_ID = 'SELLER';
  const baseFlags = { marketplace: 'DE', asin: 'B012345678' };
  const client = {
    async get() {
      return {
        items: [
          { sku: 'SKU-A', summaries: [{ asin: 'B012345678' }] },
          { sku: 'SKU-B', summaries: [{ asin: 'B012345678' }] },
        ],
      };
    },
  };

  await assert.rejects(
    () => resolveUniqueListingSku(baseFlags, client),
    (error) => error?.subtype === 'listing.asin_ambiguous',
  );
  assert.deepEqual(
    await resolveUniqueListingSku(baseFlags, client, 'SKU-B'),
    { asin: 'B012345678', sku: 'SKU-B' },
  );
  await assert.rejects(
    () => resolveUniqueListingSku(baseFlags, client, 'SKU-C'),
    (error) => error?.subtype === 'listing.asin_sku_mismatch',
  );
});

test('ASIN resolution asks for correction when the listing is not found', async () => {
  process.env.SELLER_ID = 'SELLER';
  await assert.rejects(
    () => resolveUniqueListingSku(
      { marketplace: 'DE', asin: 'B012345678' },
      { get: async () => ({ items: [] }) },
    ),
    (error) => error?.subtype === 'listing.asin_not_found' && /核对店铺、站点和 ASIN/.test(error.hintHuman),
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

test('rejects patch values whose objects contain no actual content', () => {
  const qualifiers = { marketplace_id: 'A1F83G8C2ARO7P', language_tag: 'en_GB' };
  for (const value of [
    [{}],
    [{ value: '   ' }],
    [{ value: [] }],
    // 真实事故的两种形状:限定符齐全,唯独没写值本身。把 marketplace_id /
    // language_tag 算作"内容"就会漏掉它们,一路送到 Amazon 才回
    // 99022 "does not have enough values"。
    [qualifiers],
    [{ value: '', ...qualifiers }],
    // 混着一个空元素同样会被 Amazon 拒,不能因为别的元素填了就放行。
    [{ value: 'cool box', ...qualifiers }, {}],
  ]) {
    assert.throws(
      () => listingUpdate.validate(flags([{ op: 'replace', path: '/attributes/generic_keyword', value }])),
      (error) => error?.subtype === 'empty_patch_value',
      `should reject ${JSON.stringify(value)}`,
    );
  }
});

test('accepts multi-value attribute patches that carry real content', () => {
  const qualifiers = { marketplace_id: 'A1F83G8C2ARO7P', language_tag: 'en_GB' };
  for (const [path, value] of [
    ['/attributes/generic_keyword', [{ value: 'cool box camping cooler', ...qualifiers }]],
    // 键名因属性而异:包装尺寸用 length/unit,不带 value 键也必须放行。
    ['/attributes/item_package_dimensions', [{ length: 10, unit: 'centimeters' }]],
    ['/attributes/fulfillment_availability', [{ quantity: 0 }]],
  ]) {
    assert.doesNotThrow(
      () => listingUpdate.validate(flags([{ op: 'replace', path, value }])),
      `should accept ${JSON.stringify(value)}`,
    );
  }
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
      listingUpdate.validate(flags([{ op: 'merge', path, value: [{ quantity: 1 }] }])),
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

test('seller-specific schema blocks an unknown attribute before validation preview', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx, requests } = context(
    [{ op: 'replace', path: '/attributes/product_highlight', value: [{ value: 'Guess' }] }],
    { status: 'VALID', issues: [] },
  );
  ctx.confirmationState.schemaEvidence.attributes.product_highlight = { exists: false };

  await assert.rejects(
    () => listingUpdate.dryRun(ctx),
    (error) =>
      error?.subtype === 'listing.schema_attribute_not_found' &&
      /inspect_listing_schema/.test(error.hintHuman),
  );
  assert.equal(requests.length, 0);
});

test('seller-specific schema blocks an explicitly non-editable attribute before preview', async () => {
  process.env.SELLER_ID = 'SELLER';
  const { ctx, requests } = context(
    [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }],
    { status: 'VALID', issues: [] },
  );
  ctx.confirmationState.schemaEvidence.attributes.item_name = {
    exists: true,
    editable: false,
    title: 'Item Name',
  };

  await assert.rejects(
    () => listingUpdate.dryRun(ctx),
    (error) => error?.subtype === 'listing.schema_attribute_not_editable',
  );
  assert.equal(requests.length, 0);
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

test('formal INVALID response is rejected instead of being reported as submitted', async () => {
  process.env.SELLER_ID = 'SELLER';
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const { ctx } = context(patches, { status: 'INVALID', issues: [{ severity: 'ERROR', message: 'bad value' }] });
  ctx.confirmedInput = patches;

  await assert.rejects(
    () => listingUpdate.execute(ctx),
    (error) => error?.subtype === 'listing.submission_rejected',
  );
});

test('formal response with missing status is treated as unknown and not retryable', async () => {
  process.env.SELLER_ID = 'SELLER';
  const patches = [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New name' }] }];
  const { ctx } = context(patches, { issues: [] });
  ctx.confirmedInput = patches;

  await assert.rejects(
    () => listingUpdate.execute(ctx),
    (error) => error?.subtype === 'listing.submission_status_unknown' && error?.retryable !== true,
  );
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
