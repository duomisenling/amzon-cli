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
} from '../dist/shortcuts/ads/keyword-campaign-launch.js';

const tempDirs = [];

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function plan(overrides = {}) {
  return {
    version: 1,
    launchId: 'launch-test-001',
    profileId: '123456789',
    region: 'na',
    campaign: {
      name: 'B0TEST keyword launch',
      dailyBudget: 20,
      startDate: '2026-08-01',
      biddingStrategy: 'LEGACY_FOR_SALES',
    },
    adGroup: { name: 'Core keywords', defaultBid: 0.8 },
    product: { asin: 'B012345678' },
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
      return { productAds: { error: [], success: [{ index: 0, adId: '3001' }] } };
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
      return {
        productAds: [{ campaignId: '1001', adGroupId: '2001', adId: '3001', asin: 'B012345678', state: 'ENABLED' }],
      };
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
