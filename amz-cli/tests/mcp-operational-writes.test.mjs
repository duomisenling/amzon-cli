import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAmazonMcpServer } from '../dist/mcp-server.js';
import { assertMcpWriteAllowed } from '../dist/mcp/common.js';
import { feedSubmit } from '../dist/shortcuts/feed/commands.js';
import { applyConfirmedCapture } from '../dist/tools/confirmation.js';

let stateDir;
let workDir;
const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  delete process.env.AMZ_MCP_ALLOW_WRITES;
  delete process.env.AMZ_MCP_ALLOWED_WRITES;
  delete process.env.SELLER_ID;
  globalThis.fetch = originalFetch;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  stateDir = undefined;
  workDir = undefined;
});

async function connected(factories = {}) {
  stateDir = mkdtempSync(join(tmpdir(), 'amz-mcp-writes-state-'));
  process.env.AMZ_CLI_STATE_DIR = stateDir;
  const server = createAmazonMcpServer(factories);
  const client = new Client({ name: 'mcp-write-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const budgetArgs = {
  profileId: '123456',
  region: 'na',
  campaignId: '9001',
  dailyBudget: 25,
};

test('operational write tools are explicit prepare/apply pairs with destructive apply annotations', async () => {
  const { client, server } = await connected();
  try {
    const listed = await client.listTools();
    for (const base of [
      'listing_update',
      'feed_submit',
      'ads_campaign_create',
      'ads_campaign_state',
      'ads_campaign_budget',
      'ads_keyword_bid',
      'ads_negative_keyword',
    ]) {
      const prepare = listed.tools.find((tool) => tool.name === `prepare_${base}`);
      const apply = listed.tools.find((tool) => tool.name === `apply_${base}`);
      assert.ok(prepare, `missing prepare_${base}`);
      assert.ok(apply, `missing apply_${base}`);
      assert.equal(prepare.annotations.readOnlyHint, true);
      assert.equal(apply.annotations.readOnlyHint, false);
      assert.equal(apply.annotations.destructiveHint, true);
      assert.equal(apply.annotations.idempotentHint, false);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('global write switch does not bypass the per-operation allowlist', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  let writes = 0;
  let currentBudget = 10;
  const fakeAds = {
    async request(method, path, opts) {
      if (method === 'POST' && path === '/sp/campaigns/list') {
        return { campaigns: [{ campaignId: '9001', name: 'Safe', state: 'PAUSED', budget: { budget: currentBudget } }] };
      }
      if (method === 'PUT') {
        writes += 1;
        currentBudget = opts.body.campaigns[0].budget.budget;
      }
      return { campaigns: { success: [{ campaignId: '9001' }] } };
    },
  };
  const { client, server } = await connected({ adsClient: () => fakeAds });
  try {
    const prepared = await client.callTool({ name: 'prepare_ads_campaign_budget', arguments: budgetArgs });
    const blocked = await client.callTool({
      name: 'apply_ads_campaign_budget',
      arguments: { ...budgetArgs, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /mcp_write_not_allowed/);
    assert.equal(writes, 0);

    process.env.AMZ_MCP_ALLOWED_WRITES = 'ads.campaign-budget';
    const applied = await client.callTool({
      name: 'apply_ads_campaign_budget',
      arguments: { ...budgetArgs, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(applied.isError, undefined);
    assert.equal(writes, 1);
    assert.equal(applied.structuredContent.executed.readback.campaignId, '9001');
    assert.equal(applied.structuredContent.executed.verificationStatus, 'VERIFIED');
  } finally {
    await client.close();
    await server.close();
  }
});

test('a changed remote budget invalidates the reviewed token before any write', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'ads.campaign-budget';
  let reads = 0;
  let writes = 0;
  const fakeAds = {
    async request(method, path) {
      if (method === 'POST' && path === '/sp/campaigns/list') {
        reads += 1;
        const budget = reads <= 2 ? 10 : 11;
        return { campaigns: [{ campaignId: '9001', name: 'Safe', state: 'PAUSED', budget: { budget } }] };
      }
      if (method === 'PUT') writes += 1;
      return {};
    },
  };
  const { client, server } = await connected({ adsClient: () => fakeAds });
  try {
    const prepared = await client.callTool({ name: 'prepare_ads_campaign_budget', arguments: budgetArgs });
    const applied = await client.callTool({
      name: 'apply_ads_campaign_budget',
      arguments: { ...budgetArgs, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(applied.isError, true);
    assert.match(applied.content[0].text, /preview_token_mismatch/);
    assert.equal(writes, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('campaign create/state, keyword bid, and negative keyword each require their own approved apply call', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = [
    'ads.campaign-create',
    'ads.campaign-state',
    'ads.keyword-bid',
    'ads.negative-keyword',
  ].join(',');
  const writes = [];
  const campaigns = new Map([['9100', { campaignId: '9100', name: 'Created', state: 'PAUSED', budget: { budget: 15 } }]]);
  const keywords = new Map([['8100', { keywordId: '8100', keywordText: 'steel rack', matchType: 'EXACT', state: 'ENABLED', bid: 0.5 }]]);
  const fakeAds = {
    async request(method, path, opts) {
      if (method === 'POST' && path === '/sp/campaigns/list') {
        const id = String(opts.body.campaignIdFilter.include[0]);
        return { campaigns: campaigns.has(id) ? [campaigns.get(id)] : [] };
      }
      if (method === 'POST' && path === '/sp/campaigns') {
        writes.push('campaign-create');
        const campaign = { campaignId: '9200', ...opts.body.campaigns[0] };
        campaigns.set('9200', campaign);
        return { campaigns: { error: [], success: [{ campaignId: '9200' }] } };
      }
      if (method === 'PUT' && path === '/sp/campaigns') {
        writes.push('campaign-state');
        const change = opts.body.campaigns[0];
        campaigns.set(String(change.campaignId), { ...campaigns.get(String(change.campaignId)), ...change });
        return { campaigns: { error: [], success: [{ campaignId: String(change.campaignId) }] } };
      }
      if (method === 'POST' && path === '/sp/keywords/list') {
        const id = String(opts.body.keywordIdFilter.include[0]);
        return { keywords: keywords.has(id) ? [keywords.get(id)] : [] };
      }
      if (method === 'PUT' && path === '/sp/keywords') {
        writes.push('keyword-bid');
        const change = opts.body.keywords[0];
        keywords.set(String(change.keywordId), { ...keywords.get(String(change.keywordId)), ...change });
        return { keywords: { error: [], success: [{ keywordId: String(change.keywordId) }] } };
      }
      if (method === 'POST' && path === '/sp/negativeKeywords') {
        writes.push('negative-keyword');
        return { negativeKeywords: { error: [], success: [{ negativeKeywordId: '7100' }] } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const { client, server } = await connected({ adsClient: () => fakeAds });
  try {
    const createArgs = {
      profileId: '123456', region: 'na', name: 'MCP created', targetingType: 'MANUAL',
      dailyBudget: 15, start: '2026-08-01', state: 'PAUSED',
    };
    const preparedCreate = await client.callTool({ name: 'prepare_ads_campaign_create', arguments: createArgs });
    const created = await client.callTool({
      name: 'apply_ads_campaign_create',
      arguments: { ...createArgs, previewToken: preparedCreate.structuredContent.previewToken },
    });
    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent.executed.verificationStatus, 'VERIFIED');

    const stateArgs = { profileId: '123456', region: 'na', campaignId: '9100', state: 'ENABLED' };
    const preparedState = await client.callTool({ name: 'prepare_ads_campaign_state', arguments: stateArgs });
    const changedState = await client.callTool({
      name: 'apply_ads_campaign_state',
      arguments: { ...stateArgs, previewToken: preparedState.structuredContent.previewToken },
    });
    assert.equal(changedState.structuredContent.executed.verificationStatus, 'VERIFIED');

    const bidArgs = { profileId: '123456', region: 'na', keywordId: '8100', bid: 0.8 };
    const preparedBid = await client.callTool({ name: 'prepare_ads_keyword_bid', arguments: bidArgs });
    const changedBid = await client.callTool({
      name: 'apply_ads_keyword_bid',
      arguments: { ...bidArgs, previewToken: preparedBid.structuredContent.previewToken },
    });
    assert.equal(changedBid.structuredContent.executed.verificationStatus, 'VERIFIED');

    const negativeArgs = {
      profileId: '123456', region: 'na', campaignId: '9100', adGroupId: '6100',
      text: 'free', match: 'NEGATIVE_EXACT',
    };
    const preparedNegative = await client.callTool({ name: 'prepare_ads_negative_keyword', arguments: negativeArgs });
    const negative = await client.callTool({
      name: 'apply_ads_negative_keyword',
      arguments: { ...negativeArgs, previewToken: preparedNegative.structuredContent.previewToken },
    });
    assert.equal(negative.structuredContent.executed.verificationStatus, 'SERVER_RESPONSE_ONLY');
    assert.deepEqual(writes, ['campaign-create', 'campaign-state', 'keyword-bid', 'negative-keyword']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('listing MCP uses validation preview, binds current attributes, writes once, then reads back', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'listing.update';
  process.env.SELLER_ID = 'SELLER123';
  const calls = [];
  const fakeSp = {
    async get(path, query, region) {
      calls.push({ method: 'GET', path, query, region });
      return { attributes: { item_name: [{ value: 'Old title' }] }, issues: [] };
    },
    async request(method, path, opts) {
      calls.push({ method, path, opts });
      if (path.includes('mode=VALIDATION_PREVIEW')) return { status: 'VALID', issues: [] };
      return { status: 'ACCEPTED', submissionId: 'submission-1', issues: [] };
    },
  };
  const args = {
    marketplace: 'US',
    sku: 'SKU-1',
    productType: 'PRODUCT',
    patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New title' }] }],
  };
  const { client, server } = await connected({ spClient: () => fakeSp });
  try {
    const prepared = await client.callTool({ name: 'prepare_listing_update', arguments: args });
    assert.equal(prepared.isError, undefined);
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, 1);
    assert.match(calls.find((call) => call.method === 'PATCH').path, /mode=VALIDATION_PREVIEW/);

    const applied = await client.callTool({
      name: 'apply_listing_update',
      arguments: { ...args, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(applied.isError, undefined);
    const patches = calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.doesNotMatch(patches[1].path, /mode=VALIDATION_PREVIEW/);
    assert.equal(applied.structuredContent.executed.processingStatus, 'SUBMITTED');
    assert.ok(applied.structuredContent.executed.immediateReadback);
  } finally {
    await client.close();
    await server.close();
  }
});

test('feed MCP rejects a replaced file, then submits frozen content and returns asynchronous status', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'feed.submit';
  workDir = mkdtempSync(join(tmpdir(), 'amz-mcp-feed-'));
  const file = join(workDir, 'inventory.tsv');
  const original = 'sku\tquantity\nSKU-1\t5\n';
  writeFileSync(file, original, 'utf8');
  let createFeedCalls = 0;
  let uploadedBody;
  const fakeSp = {
    async request(method, path) {
      if (path.endsWith('/documents')) return { feedDocumentId: 'doc-1', url: 'https://upload.example.test/doc-1' };
      if (path.endsWith('/feeds')) {
        createFeedCalls += 1;
        return { feedId: 'feed-1' };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async get() {
      return { feedId: 'feed-1', processingStatus: 'IN_QUEUE' };
    },
  };
  globalThis.fetch = async (_url, opts) => {
    uploadedBody = opts.body;
    return new Response('', { status: 200 });
  };
  const args = { marketplace: 'US', type: 'POST_FLAT_FILE_INVLOADER_DATA', file };
  const { client, server } = await connected({ spClient: () => fakeSp });
  try {
    const prepared = await client.callTool({ name: 'prepare_feed_submit', arguments: args });
    writeFileSync(file, 'sku\tquantity\nSKU-1\t99\n', 'utf8');
    const rejected = await client.callTool({
      name: 'apply_feed_submit',
      arguments: { ...args, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /preview_token_mismatch/);
    assert.equal(createFeedCalls, 0);

    writeFileSync(file, original, 'utf8');
    const preparedAgain = await client.callTool({ name: 'prepare_feed_submit', arguments: args });
    const applied = await client.callTool({
      name: 'apply_feed_submit',
      arguments: { ...args, previewToken: preparedAgain.structuredContent.previewToken },
    });
    assert.equal(applied.isError, undefined);
    assert.equal(createFeedCalls, 1);
    assert.equal(uploadedBody, original);
    assert.equal(applied.structuredContent.executed.submissionStatus, 'SUBMITTED');
    assert.equal(applied.structuredContent.executed.immediateStatus.processingStatus, 'IN_QUEUE');
  } finally {
    await client.close();
    await server.close();
  }
});

test('an explicitly empty allowlist denies every write including the legacy default operation', () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  delete process.env.AMZ_MCP_ALLOWED_WRITES;
  assert.doesNotThrow(() => assertMcpWriteAllowed('ads.keyword-campaign-launch'));

  for (const explicitlyEmpty of ['', '   ', ',']) {
    process.env.AMZ_MCP_ALLOWED_WRITES = explicitlyEmpty;
    assert.throws(
      () => assertMcpWriteAllowed('ads.keyword-campaign-launch'),
      (error) => error?.subtype === 'mcp_write_not_allowed',
      `allowlist ${JSON.stringify(explicitlyEmpty)} should deny the legacy default`,
    );
  }
});

test('confirmed capture populates both confirmedInput and confirmationState for execute', () => {
  const ctx = {};
  applyConfirmedCapture(ctx, {
    input: ['frozen-patch'],
    snapshot: { runtime: {}, remoteState: { sellerId: 'SELLER123' } },
  });
  assert.deepEqual(ctx.confirmedInput, ['frozen-patch']);
  assert.deepEqual(ctx.confirmationState, { sellerId: 'SELLER123' });
});

test('prepare succeeds while writes are disabled but reports the apply gate as blocked', async () => {
  const fakeAds = {
    async request(method, path) {
      if (method === 'POST' && path === '/sp/campaigns/list') {
        return { campaigns: [{ campaignId: '9001', name: 'Safe', state: 'PAUSED', budget: { budget: 10 } }] };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const { client, server } = await connected({ adsClient: () => fakeAds });
  try {
    const prepared = await client.callTool({ name: 'prepare_ads_campaign_budget', arguments: budgetArgs });
    assert.equal(prepared.isError, undefined);
    assert.ok(prepared.structuredContent.previewToken);
    assert.equal(prepared.structuredContent.applyAllowed, false);
    assert.match(prepared.structuredContent.applyBlockedReason, /AMZ_MCP_ALLOW_WRITES/);
    assert.match(prepared.structuredContent.nextStep, /无法兑现/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a readback failure after an accepted listing submission still reports SUBMITTED', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'listing.update';
  process.env.SELLER_ID = 'SELLER123';
  let formalPatchDone = false;
  const fakeSp = {
    async get() {
      if (formalPatchDone) throw new Error('readback boom');
      return { attributes: { item_name: [{ value: 'Old title' }] }, issues: [] };
    },
    async request(_method, path) {
      if (path.includes('mode=VALIDATION_PREVIEW')) return { status: 'VALID', issues: [] };
      formalPatchDone = true;
      return { status: 'ACCEPTED', submissionId: 'submission-2', issues: [] };
    },
  };
  const args = {
    marketplace: 'US',
    sku: 'SKU-1',
    productType: 'PRODUCT',
    patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New title' }] }],
  };
  const { client, server } = await connected({ spClient: () => fakeSp });
  try {
    const prepared = await client.callTool({ name: 'prepare_listing_update', arguments: args });
    assert.equal(prepared.isError, undefined);
    const applied = await client.callTool({
      name: 'apply_listing_update',
      arguments: { ...args, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(applied.isError, undefined, applied.content?.[0]?.text);
    assert.equal(applied.structuredContent.executed.processingStatus, 'SUBMITTED');
    assert.match(applied.structuredContent.executed.readbackError, /readback boom/);
    assert.equal(applied.structuredContent.executed.immediateReadback, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test('feed success response without feedId is reported as unknown and must not be retried', async () => {
  globalThis.fetch = async () => new Response('', { status: 200 });
  const ctx = {
    flags: { marketplace: 'US', type: 'POST_FLAT_FILE_INVLOADER_DATA', file: 'unused.tsv' },
    confirmedInput: 'sku\tquantity\nSKU-1\t5\n',
    progress() {},
    client: {
      async request(_method, path) {
        if (path.endsWith('/documents')) {
          return { feedDocumentId: 'doc-unknown', url: 'https://upload.example.test/doc-unknown' };
        }
        if (path.endsWith('/feeds')) return {};
        throw new Error(`unexpected ${path}`);
      },
    },
  };
  await assert.rejects(
    () => feedSubmit.execute(ctx),
    (error) => error?.subtype === 'feed.submit_result_unknown' && error?.retryable !== true,
  );
});
