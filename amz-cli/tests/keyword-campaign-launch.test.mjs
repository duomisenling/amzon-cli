import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { AmzError } from '../dist/internal/errs/errors.js';
import {
  executeKeywordCampaignPlan,
  keywordCampaignPreview,
  parseKeywordCampaignPlan,
  preflightKeywordCampaignProducts,
} from '../dist/shortcuts/ads/keyword-campaign-launch.js';

const tempDirs = [];

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  delete process.env.SELLER_ID;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function plan(overrides = {}) {
  return {
    version: 1,
    launchId: 'launch-test-001',
    profileId: '123456789',
    region: 'na',
    marketplace: 'US',
    campaign: {
      name: 'B0TEST keyword launch',
      dailyBudget: 20,
      startDate: '2026-08-01',
      biddingStrategy: 'LEGACY_FOR_SALES',
    },
    adGroup: { name: 'Core keywords', defaultBid: 0.8 },
    product: { sku: 'SKU-1', asin: 'B012345678' },
    keywords: [
      { text: 'soap bar', matchType: 'EXACT', bid: 0.75 },
      { text: 'natural soap', matchType: 'PHRASE', bid: 0.65 },
    ],
    enableAfterCreate: true,
    ...overrides,
  };
}

function isolatedState() {
  const dir = mkdtempSync(join(tmpdir(), 'amz-keyword-launch-'));
  tempDirs.push(dir);
  process.env.AMZ_CLI_STATE_DIR = dir;
  return dir;
}

class SuccessfulAdsClient {
  calls = [];

  async request(method, path, opts) {
    this.calls.push({ method, path, opts });
    if (method === 'POST' && path === '/sp/campaigns') {
      assert.equal(opts.body.campaigns[0].state, 'PAUSED');
      return { campaigns: { error: [], success: [{ index: 0, campaignId: '1001' }] } };
    }
    if (method === 'POST' && path === '/sp/adGroups') {
      return { adGroups: { error: [], success: [{ index: 0, adGroupId: '2001' }] } };
    }
    if (method === 'POST' && path === '/sp/productAds') {
      // 动态按请求条数生成 adId,并记住完整内容供 list 回读(支持多商品)
      this.createdAds ??= [];
      const success = opts.body.productAds.map((ad, index) => {
        const adId = String(3001 + this.createdAds.length);
        this.createdAds.push({ ...ad, adId });
        return { index, adId };
      });
      return { productAds: { error: [], success } };
    }
    if (method === 'POST' && path === '/sp/keywords') {
      return {
        keywords: {
          error: [],
          success: opts.body.keywords.map((keyword, index) => ({
            index,
            keywordId: keyword.keywordText === 'natural soap' ? '4002' : '4001',
          })),
        },
      };
    }
    if (method === 'POST' && path === '/sp/campaigns/list') {
      return { campaigns: [{ campaignId: '1001', state: 'PAUSED' }] };
    }
    if (method === 'POST' && path === '/sp/adGroups/list') {
      return { adGroups: [{ campaignId: '1001', adGroupId: '2001', state: 'ENABLED' }] };
    }
    if (method === 'POST' && path === '/sp/productAds/list') {
      const include = opts.body.adIdFilter.include.map(String);
      const known = this.createdAds ?? [
        { campaignId: '1001', adGroupId: '2001', adId: '3001', sku: 'SKU-1', state: 'ENABLED' },
      ];
      return { productAds: known.filter((ad) => include.includes(String(ad.adId))) };
    }
    if (method === 'POST' && path === '/sp/keywords/list') {
      return {
        keywords: opts.body.keywordIdFilter.include.map((keywordId) => ({
          campaignId: '1001',
          adGroupId: '2001',
          keywordId,
          state: 'ENABLED',
        })),
      };
    }
    if (method === 'PUT' && path === '/sp/campaigns') {
      return { campaigns: { error: [], success: [{ index: 0, campaignId: '1001' }] } };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  }
}

test('plan validation rejects duplicate keyword+match and impossible calendar dates', () => {
  const duplicate = plan({
    keywords: [
      { text: ' Soap   Bar ', matchType: 'EXACT', bid: 0.7 },
      { text: 'soap bar', matchType: 'EXACT', bid: 0.8 },
    ],
  });
  assert.throws(() => parseKeywordCampaignPlan(JSON.stringify(duplicate)), /duplicate keyword/);

  const impossibleDate = plan();
  impossibleDate.campaign.startDate = '2026-02-30';
  assert.throws(() => parseKeywordCampaignPlan(JSON.stringify(impossibleDate)), /invalid calendar date/);
});

test('preview is local, shows a PAUSED campaign, and preserves the complete reviewed plan', () => {
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  const preview = keywordCampaignPreview(parsed);
  assert.equal(preview.campaign.campaigns[0].state, 'PAUSED');
  assert.equal(preview.keywordCount, 2);
  assert.equal(preview.keywords[1].text, 'natural soap');
  assert.match(preview.finalState, /ENABLED/);
  assert.match(preview.planHash, /^[a-f0-9]{64}$/);
});

test('full launch creates children while paused, verifies them, then enables last', async () => {
  isolatedState();
  const client = new SuccessfulAdsClient();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  const result = await executeKeywordCampaignPlan(client, parsed);

  assert.equal(result.state, 'ENABLED');
  assert.deepEqual(
    client.calls.map(({ method, path }) => `${method} ${path}`),
    [
      'POST /sp/campaigns',
      'POST /sp/adGroups',
      'POST /sp/productAds',
      'POST /sp/keywords',
      'POST /sp/campaigns/list',
      'POST /sp/adGroups/list',
      'POST /sp/productAds/list',
      'POST /sp/keywords/list',
      'PUT /sp/campaigns',
    ],
  );
});

test('paused launch (enableAfterCreate=false) never enables and guides the separate enable step', async () => {
  isolatedState();
  const client = new SuccessfulAdsClient();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan({ enableAfterCreate: false })));
  const result = await executeKeywordCampaignPlan(client, parsed);

  assert.equal(result.state, 'PAUSED');
  assert.equal(result.enabled, false);
  // 第一阶段绝不启用:不能出现启用用的 PUT /sp/campaigns
  assert.equal(client.calls.some(({ method, path }) => method === 'PUT' && path === '/sp/campaigns'), false);
  // 返回要给出第二阶段开启指引(列清后单独启用)
  assert.match(result.next, /campaign-state/);
  assert.match(result.next, /开启后立即投放花钱|开启/);
});

test('HTTP 207-style partial keyword result is journaled and never enables the campaign', async () => {
  const stateDir = isolatedState();
  const client = new SuccessfulAdsClient();
  client.request = async function (method, path, opts) {
    if (method === 'POST' && path === '/sp/keywords') {
      this.calls.push({ method, path, opts });
      return {
        keywords: {
          success: [{ index: 0, keywordId: '4001' }],
          error: [{ index: 1, code: 'INVALID_ARGUMENT', message: 'bad keyword' }],
        },
      };
    }
    return SuccessfulAdsClient.prototype.request.call(this, method, path, opts);
  };

  await assert.rejects(
    executeKeywordCampaignPlan(client, parseKeywordCampaignPlan(JSON.stringify(plan()))),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_partial_failure',
  );
  assert.equal(client.calls.some(({ method, path }) => method === 'PUT' && path === '/sp/campaigns'), false);
  const journalFile = join(stateDir, 'launches');
  const journalName = (await import('node:fs')).readdirSync(journalFile)[0];
  const journal = JSON.parse(readFileSync(join(journalFile, journalName), 'utf8'));
  assert.equal(journal.status, 'PARTIAL_FAILURE');
  assert.deepEqual(journal.completedKeywordIndexes, [0]);
});

test('resume after a partial keyword response submits only missing keywords', async () => {
  isolatedState();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  const first = new SuccessfulAdsClient();
  first.request = async function (method, path, opts) {
    if (method === 'POST' && path === '/sp/keywords') {
      this.calls.push({ method, path, opts });
      return { keywords: { success: [{ index: 0, keywordId: '4001' }], error: [{ index: 1, code: 'BAD' }] } };
    }
    return SuccessfulAdsClient.prototype.request.call(this, method, path, opts);
  };
  await assert.rejects(executeKeywordCampaignPlan(first, parsed));

  const resumed = new SuccessfulAdsClient();
  const result = await executeKeywordCampaignPlan(resumed, parsed);
  const createKeywords = resumed.calls.find(({ path }) => path === '/sp/keywords');
  assert.equal(createKeywords.opts.body.keywords.length, 1);
  assert.equal(createKeywords.opts.body.keywords[0].keywordText, 'natural soap');
  assert.equal(resumed.calls.some(({ method, path }) => method === 'POST' && path === '/sp/campaigns'), false);
  assert.equal(result.state, 'ENABLED');
});

test('ambiguous write result blocks automatic resume instead of replaying create', async () => {
  isolatedState();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  const first = new SuccessfulAdsClient();
  first.request = async function (method, path, opts) {
    this.calls.push({ method, path, opts });
    if (method === 'POST' && path === '/sp/campaigns') {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'ads.write_result_unknown',
        hintAgent: 'report_to_human',
        hintHuman: 'unknown',
        message: 'timeout after dispatch',
      });
    }
    throw new Error('unexpected');
  };
  await assert.rejects(executeKeywordCampaignPlan(first, parsed), /timeout after dispatch/);

  const second = new SuccessfulAdsClient();
  await assert.rejects(
    executeKeywordCampaignPlan(second, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_reconcile_required',
  );
  assert.equal(second.calls.length, 0);
});

test('legacy single-product plans still parse into a products array', () => {
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  assert.equal(parsed.products.length, 1);
  assert.equal(parsed.products[0].sku, 'SKU-1');
  assert.equal(parsed.product, undefined);
});

test('ASIN-only products are rejected before any Ads request can be made', () => {
  const p = plan({ products: [{ asin: 'B012345678' }] });
  delete p.product;
  assert.throws(() => parseKeywordCampaignPlan(JSON.stringify(p)), /sku/i);
});

test('product preflight verifies all SKUs in one store listing request', async () => {
  process.env.SELLER_ID = 'SELLER';
  const calls = [];
  const client = {
    async get(path, query, region) {
      calls.push({ path, query, region });
      return { items: [{ sku: 'SKU-1' }, { sku: 'SKU-2' }] };
    },
  };
  const p = plan({ products: [{ sku: 'SKU-1' }, { sku: 'SKU-2', asin: 'B012345678' }] });
  delete p.product;
  const parsed = parseKeywordCampaignPlan(JSON.stringify(p));

  const result = await preflightKeywordCampaignProducts(client, parsed);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.identifiersType, 'SKU');
  assert.equal(calls[0].query.identifiers, 'SKU-1,SKU-2');
  assert.equal(calls[0].query.marketplaceIds, 'ATVPDKIKX0DER');
  assert.equal(calls[0].region, 'na');
  assert.deepEqual(result.verifiedProducts, [{ sku: 'SKU-1' }, { sku: 'SKU-2', asin: 'B012345678' }]);
});

test('product preflight rejects a missing SKU before Ads execution', async () => {
  process.env.SELLER_ID = 'SELLER';
  const client = { get: async () => ({ items: [{ sku: 'SKU-1' }] }) };
  const p = plan({ products: [{ sku: 'SKU-1' }, { sku: 'MISSING-SKU' }] });
  delete p.product;
  const parsed = parseKeywordCampaignPlan(JSON.stringify(p));

  await assert.rejects(
    preflightKeywordCampaignProducts(client, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_sku_not_in_store',
  );
});

test('product preflight rejects marketplace and Ads region mismatch without a request', async () => {
  const p = plan({ marketplace: 'FR', region: 'na' });
  const parsed = parseKeywordCampaignPlan(JSON.stringify(p));
  let requested = false;
  await assert.rejects(
    preflightKeywordCampaignProducts({ get: async () => { requested = true; } }, parsed),
    /region=na/,
  );
  assert.equal(requested, false);
});

test('duplicate products in a plan are rejected locally', () => {
  const p = plan({ products: [{ sku: 'SKU-1' }, { sku: 'SKU-1', asin: 'B012345678' }] });
  delete p.product;
  assert.throws(() => parseKeywordCampaignPlan(JSON.stringify(p)), /duplicate product/);
});

test('multi-product plan creates all product ads in one call and verifies each one', async () => {
  isolatedState();
  const client = new SuccessfulAdsClient();
  const p = plan({
    products: [
      { sku: 'VARIANT-SKU-1', asin: 'B012345678' },
      { sku: 'VARIANT-SKU-2', asin: 'B012345679' },
      { sku: 'VARIANT-SKU-3', asin: 'B012345670' },
      { sku: 'VARIANT-SKU-4', asin: 'B012345680' },
    ],
  });
  delete p.product;
  const parsed = parseKeywordCampaignPlan(JSON.stringify(p));

  const preview = keywordCampaignPreview(parsed);
  assert.equal(preview.productCount, 4);
  assert.equal(preview.products[2].sku, 'VARIANT-SKU-3');

  const result = await executeKeywordCampaignPlan(client, parsed);
  const createCalls = client.calls.filter(({ method, path }) => method === 'POST' && path === '/sp/productAds');
  assert.equal(createCalls.length, 1, 'all product ads must be created in a single array call');
  assert.equal(createCalls[0].opts.body.productAds.length, 4);
  assert.deepEqual(
    createCalls[0].opts.body.productAds.map(({ sku }) => sku),
    ['VARIANT-SKU-1', 'VARIANT-SKU-2', 'VARIANT-SKU-3', 'VARIANT-SKU-4'],
  );
  assert.equal(createCalls[0].opts.body.productAds.some((product) => 'asin' in product), false);
  assert.equal(result.productCount, 4);
  assert.equal(Object.keys(result.adIds).length, 4);
  assert.equal(result.state, 'ENABLED');
});

test('unrecognized 207 shape on create is journaled as RESULT_UNKNOWN and blocks automatic resume', async () => {
  const stateDir = isolatedState();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  const first = new SuccessfulAdsClient();
  first.request = async function (method, path, opts) {
    this.calls.push({ method, path, opts });
    // HTTP 成功但 207 结构不识别:Campaign 可能已创建,不能按 PARTIAL_FAILURE 续跑
    if (method === 'POST' && path === '/sp/campaigns') return { unexpected: true };
    throw new Error('unexpected');
  };
  await assert.rejects(
    executeKeywordCampaignPlan(first, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_result_unknown',
  );
  const journalDir = join(stateDir, 'launches');
  const journalName = (await import('node:fs')).readdirSync(journalDir)[0];
  const journal = JSON.parse(readFileSync(join(journalDir, journalName), 'utf8'));
  assert.equal(journal.status, 'RESULT_UNKNOWN');

  // 结果不明后禁止自动续跑(重跑会重复创建整套广告)
  const second = new SuccessfulAdsClient();
  await assert.rejects(
    executeKeywordCampaignPlan(second, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_reconcile_required',
  );
  assert.equal(second.calls.length, 0);
});

test('a success item without a campaignId is RESULT_UNKNOWN, not a resumable partial failure', async () => {
  const stateDir = isolatedState();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));
  const client = new SuccessfulAdsClient();
  client.request = async function (method, path, opts) {
    this.calls.push({ method, path, opts });
    if (method === 'POST' && path === '/sp/campaigns') {
      // 结构识别但成功项取不到 id:Campaign 已创建却无法登记,续跑会重复创建
      return { campaigns: { error: [], success: [{ index: 0 }] } };
    }
    throw new Error('unexpected');
  };
  await assert.rejects(
    executeKeywordCampaignPlan(client, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_result_unknown',
  );
  const journalDir = join(stateDir, 'launches');
  const journalName = (await import('node:fs')).readdirSync(journalDir)[0];
  const journal = JSON.parse(readFileSync(join(journalDir, journalName), 'utf8'));
  assert.equal(journal.status, 'RESULT_UNKNOWN');
});

test('resume after an enable-step failure verifies against an already-ENABLED remote campaign', async () => {
  isolatedState();
  const parsed = parseKeywordCampaignPlan(JSON.stringify(plan()));

  // 第一次:创建/验证全部成功,第 6 步启用被拒 → PARTIAL_FAILURE(远端可能实际已启用)
  const first = new SuccessfulAdsClient();
  first.request = async function (method, path, opts) {
    if (method === 'PUT' && path === '/sp/campaigns') {
      this.calls.push({ method, path, opts });
      return { campaigns: { success: [], error: [{ code: 'THROTTLED' }] } };
    }
    return SuccessfulAdsClient.prototype.request.call(this, method, path, opts);
  };
  await assert.rejects(
    executeKeywordCampaignPlan(first, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_partial_failure',
  );

  // 第二次续跑:远端 Campaign 实际已是 ENABLED,回读验证必须接受(否则永远卡死)
  const resumed = new SuccessfulAdsClient();
  resumed.createdAds = [{ campaignId: '1001', adGroupId: '2001', adId: '3001', sku: 'SKU-1', state: 'ENABLED' }];
  resumed.request = async function (method, path, opts) {
    if (method === 'POST' && path === '/sp/campaigns/list') {
      this.calls.push({ method, path, opts });
      return { campaigns: [{ campaignId: '1001', state: 'ENABLED' }] };
    }
    return SuccessfulAdsClient.prototype.request.call(this, method, path, opts);
  };
  const result = await executeKeywordCampaignPlan(resumed, parsed);
  assert.equal(result.state, 'ENABLED');
  assert.equal(result.journalStatus, 'ENABLED');
  // 续跑不允许重新创建任何对象
  assert.equal(resumed.calls.some(({ method, path }) => method === 'POST' && path === '/sp/campaigns'), false);
  assert.equal(resumed.calls.some(({ method, path }) => method === 'POST' && path === '/sp/keywords'), false);
});

test('partial product-ad failure journals progress and resume submits only the missing product', async () => {
  isolatedState();
  const p = plan({ products: [{ sku: 'VARIANT-SKU-1' }, { sku: 'VARIANT-SKU-2' }] });
  delete p.product;
  const parsed = parseKeywordCampaignPlan(JSON.stringify(p));

  const first = new SuccessfulAdsClient();
  first.request = async function (method, path, opts) {
    if (method === 'POST' && path === '/sp/productAds') {
      this.calls.push({ method, path, opts });
      this.createdAds = [{ ...opts.body.productAds[0], adId: '3001' }];
      return { productAds: { success: [{ index: 0, adId: '3001' }], error: [{ index: 1, code: 'BAD_PRODUCT' }] } };
    }
    return SuccessfulAdsClient.prototype.request.call(this, method, path, opts);
  };
  await assert.rejects(
    executeKeywordCampaignPlan(first, parsed),
    (error) => error instanceof AmzError && error.subtype === 'ads.keyword_campaign_partial_failure',
  );

  const resumed = new SuccessfulAdsClient();
  resumed.createdAds = [...first.createdAds];
  const result = await executeKeywordCampaignPlan(resumed, parsed);
  const createCall = resumed.calls.find(({ method, path }) => method === 'POST' && path === '/sp/productAds');
  assert.equal(createCall.opts.body.productAds.length, 1, 'resume must only create the missing product ad');
  assert.equal(createCall.opts.body.productAds[0].sku, 'VARIANT-SKU-2');
  assert.equal(resumed.calls.some(({ method, path }) => method === 'POST' && path === '/sp/campaigns'), false);
  assert.equal(Object.keys(result.adIds).length, 2);
  assert.equal(result.state, 'ENABLED');
});
