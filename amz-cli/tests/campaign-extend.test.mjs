import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  campaignExtensionPlanSchema,
  captureCampaignExtensionState,
  executeCampaignExtension,
} from '../dist/shortcuts/ads/campaign-extend.js';
import { createAmazonMcpServer } from '../dist/mcp-server.js';
import { AmzError } from '../dist/internal/errs/errors.js';

let stateDir;

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  delete process.env.AMZ_MCP_ALLOW_WRITES;
  delete process.env.AMZ_MCP_ALLOWED_WRITES;
  delete process.env.SELLER_ID;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

function plan(overrides = {}) {
  return {
    version: 1,
    profileId: '123456',
    region: 'eu',
    marketplace: 'FR',
    campaignId: '9001',
    adGroupId: '8001',
    products: [
      { sku: 'SKU-1', asin: 'B012345678' },
      { sku: 'SKU-2', asin: 'B012345679' },
    ],
    keywords: [
      { text: 'knee brace', matchType: 'EXACT', bid: 0.5 },
      { text: 'sport support', matchType: 'PHRASE', bid: 0.6 },
    ],
    ...overrides,
  };
}

function spClient(existingSkus = ['SKU-1', 'SKU-2']) {
  return {
    async get(_path, query) {
      const requested = String(query.identifiers ?? '').split(',').filter(Boolean);
      return { items: requested.filter((sku) => existingSkus.includes(sku)).map((sku) => ({ sku })) };
    },
  };
}

class ExtensionAdsClient {
  constructor() {
    this.campaign = { campaignId: '9001', name: 'Existing manual', state: 'PAUSED', targetingType: 'MANUAL' };
    this.adGroup = { adGroupId: '8001', campaignId: '9001', name: 'Existing group', state: 'ENABLED' };
    this.productAds = [{ campaignId: '9001', adGroupId: '8001', adId: '7001', sku: 'SKU-1', state: 'ENABLED' }];
    this.keywords = [{
      campaignId: '9001', adGroupId: '8001', keywordId: '6001', keywordText: 'Knee   Brace',
      matchType: 'EXACT', bid: 0.4, state: 'ENABLED',
    }];
    this.calls = [];
    this.partialProductWrite = false;
  }

  async request(method, path, opts) {
    this.calls.push({ method, path, opts });
    if (method === 'POST' && path === '/sp/campaigns/list') return { campaigns: [this.campaign] };
    if (method === 'POST' && path === '/sp/adGroups/list') return { adGroups: [this.adGroup] };
    if (method === 'POST' && path === '/sp/productAds/list') return { productAds: [...this.productAds] };
    if (method === 'POST' && path === '/sp/keywords/list') return { keywords: [...this.keywords] };
    if (method === 'POST' && path === '/sp/productAds') {
      const requested = opts.body.productAds;
      if (this.partialProductWrite && requested.length > 1) {
        this.productAds.push({ ...requested[0], adId: '7002' });
        return { productAds: { success: [{ index: 0, adId: '7002' }], error: [{ index: 1, code: 'REJECTED' }] } };
      }
      requested.forEach((item, index) => this.productAds.push({ ...item, adId: String(7100 + index + this.productAds.length) }));
      return { productAds: { success: requested.map((_, index) => ({ index, adId: String(7100 + index) })), error: [] } };
    }
    if (method === 'POST' && path === '/sp/keywords') {
      const requested = opts.body.keywords;
      requested.forEach((item, index) => this.keywords.push({ ...item, keywordId: String(6100 + index + this.keywords.length) }));
      return { keywords: { success: requested.map((_, index) => ({ index, keywordId: String(6100 + index) })), error: [] } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

test('campaign extension plan requires SKU and at least one product or keyword', () => {
  assert.throws(
    () => campaignExtensionPlanSchema.parse(plan({ products: [{ asin: 'B012345678' }], keywords: [] })),
    /sku/i,
  );
  assert.throws(
    () => campaignExtensionPlanSchema.parse(plan({ products: [], keywords: [] })),
    /at least one/i,
  );
});

test('preflight identifies existing and missing products/keywords without writing', async () => {
  process.env.SELLER_ID = 'SELLER';
  const ads = new ExtensionAdsClient();
  const parsed = campaignExtensionPlanSchema.parse(plan());
  const state = await captureCampaignExtensionState(ads, spClient(), parsed);
  assert.deepEqual(state.productsToCreate.map((item) => item.sku), ['SKU-2']);
  assert.deepEqual(state.keywordsToCreate.map((item) => item.text), ['sport support']);
  assert.equal(state.existingKeywords[0].bid, 0.4, 'same text+match is existing even when its bid differs');
  assert.equal(ads.calls.some((call) => call.path === '/sp/productAds'), false);
  assert.equal(ads.calls.some((call) => call.path === '/sp/keywords'), false);
});

test('execution adds only missing items and never changes campaign/ad-group state or budget', async () => {
  process.env.SELLER_ID = 'SELLER';
  const ads = new ExtensionAdsClient();
  const parsed = campaignExtensionPlanSchema.parse(plan());
  const result = await executeCampaignExtension(ads, spClient(), parsed);
  const productWrite = ads.calls.find((call) => call.path === '/sp/productAds');
  const keywordWrite = ads.calls.find((call) => call.path === '/sp/keywords');
  assert.deepEqual(productWrite.opts.body.productAds.map((item) => item.sku), ['SKU-2']);
  assert.equal(productWrite.opts.body.productAds.some((item) => 'asin' in item), false);
  assert.deepEqual(keywordWrite.opts.body.keywords.map((item) => item.keywordText), ['sport support']);
  assert.equal(ads.calls.some((call) => call.path === '/sp/campaigns' || call.path === '/sp/adGroups'), false);
  assert.equal(result.verificationStatus, 'VERIFIED');
  assert.equal(result.campaignState, 'PAUSED');
});

test('partial success stops and a fresh run submits only the remotely missing item', async () => {
  process.env.SELLER_ID = 'SELLER';
  const ads = new ExtensionAdsClient();
  ads.productAds = [];
  ads.keywords = [];
  ads.partialProductWrite = true;
  const parsed = campaignExtensionPlanSchema.parse(plan({ keywords: [] }));
  await assert.rejects(
    executeCampaignExtension(ads, spClient(), parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.write_partial_failure',
  );
  const afterFailure = await captureCampaignExtensionState(ads, spClient(), parsed);
  assert.deepEqual(afterFailure.productsToCreate.map((item) => item.sku), ['SKU-2']);

  ads.partialProductWrite = false;
  await executeCampaignExtension(ads, spClient(), parsed);
  const writes = ads.calls.filter((call) => call.path === '/sp/productAds');
  assert.deepEqual(writes.at(-1).opts.body.productAds.map((item) => item.sku), ['SKU-2']);
});

test('wrong ad group and automatic keyword campaign fail before writes', async () => {
  process.env.SELLER_ID = 'SELLER';
  const wrongGroup = new ExtensionAdsClient();
  wrongGroup.adGroup.campaignId = '9999';
  await assert.rejects(
    captureCampaignExtensionState(wrongGroup, spClient(), campaignExtensionPlanSchema.parse(plan())),
    (error) => error instanceof AmzError && error.subtype === 'ads.campaign_extension_ad_group_mismatch',
  );
  assert.equal(wrongGroup.calls.some((call) => call.path === '/sp/productAds' || call.path === '/sp/keywords'), false);

  const automatic = new ExtensionAdsClient();
  automatic.campaign.targetingType = 'AUTO';
  await assert.rejects(
    captureCampaignExtensionState(automatic, spClient(), campaignExtensionPlanSchema.parse(plan())),
    (error) => error instanceof AmzError && error.subtype === 'ads.campaign_extension_requires_manual_campaign',
  );
});

async function connected(ads) {
  stateDir = mkdtempSync(join(tmpdir(), 'amz-campaign-extend-mcp-'));
  process.env.AMZ_CLI_STATE_DIR = stateDir;
  process.env.SELLER_ID = 'SELLER';
  const server = createAmazonMcpServer({ adsClient: () => ads, spClient: () => spClient() }, 'shop-a');
  const client = new Client({ name: 'campaign-extend-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('MCP exposes an approved prepare/apply pair and binds it to remote state', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'ads.campaign-extend';
  const ads = new ExtensionAdsClient();
  const { client, server } = await connected(ads);
  try {
    const listed = await client.listTools();
    const prepare = listed.tools.find((tool) => tool.name === 'prepare_ads_campaign_extend');
    const apply = listed.tools.find((tool) => tool.name === 'apply_ads_campaign_extend');
    assert.ok(prepare);
    assert.ok(apply);
    assert.equal(prepare.annotations.readOnlyHint, true);
    assert.equal(apply.annotations.destructiveHint, true);

    const args = { plan: plan() };
    const prepared = await client.callTool({ name: 'prepare_ads_campaign_extend', arguments: args });
    assert.equal(prepared.isError, undefined);
    assert.deepEqual(prepared.structuredContent.preview.productsToCreate.map((item) => item.sku), ['SKU-2']);
    const applied = await client.callTool({
      name: 'apply_ads_campaign_extend',
      arguments: { ...args, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(applied.isError, undefined);
    assert.equal(applied.structuredContent.executed.verificationStatus, 'VERIFIED');
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP refuses a stale preview when the target ad group changes before approval', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'ads.campaign-extend';
  const ads = new ExtensionAdsClient();
  const { client, server } = await connected(ads);
  try {
    const args = { plan: plan() };
    const prepared = await client.callTool({ name: 'prepare_ads_campaign_extend', arguments: args });
    ads.adGroup.name = 'Changed remotely';
    const applied = await client.callTool({
      name: 'apply_ads_campaign_extend',
      arguments: { ...args, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(applied.isError, true);
    assert.match(applied.content[0].text, /preview_token_mismatch/);
    assert.equal(ads.calls.some((call) => call.path === '/sp/productAds' || call.path === '/sp/keywords'), false);
  } finally {
    await client.close();
    await server.close();
  }
});

