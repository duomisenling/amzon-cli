import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsCampaignBudget } from '../dist/shortcuts/ads/campaign-budget.js';
import { adsCampaignCreate } from '../dist/shortcuts/ads/campaign-create.js';
import { adsCampaignState } from '../dist/shortcuts/ads/campaign-state.js';
import { adsKeywordBid } from '../dist/shortcuts/ads/keywords.js';

test('creating a paused campaign never performs an unpreviewed enable request', async () => {
  const calls = [];
  const ctx = {
    flags: {
      profileId: '123',
      name: 'Safety test',
      targetingType: 'AUTO',
      dailyBudget: '10',
      start: '2026-08-01',
      state: 'PAUSED',
    },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        calls.push({ method, path, opts });
        return { campaigns: { success: [{ campaignId: '456' }] } };
      },
    },
  };

  const result = await adsCampaignCreate.execute(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/sp/campaigns');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].path, '/sp/campaigns/list');
  assert.equal(calls.some((call) => call.method === 'PUT'), false);
  assert.equal(result.enabled, false);
  assert.match(result.note, /campaign-state/);
});

const createFlags = {
  profileId: '123',
  name: 'Multistatus test',
  targetingType: 'AUTO',
  dailyBudget: '10',
  start: '2026-08-01',
  state: 'PAUSED',
};

test('a fully rejected campaign create surfaces the multistatus error instead of a success envelope', async () => {
  const ctx = {
    flags: { ...createFlags },
    progress() {},
    adsClient: {
      async request() {
        return { campaigns: { success: [], error: [{ errors: [{ errorType: 'duplicateValueError' }] }] } };
      },
    },
  };
  await assert.rejects(
    () => adsCampaignCreate.execute(ctx),
    (error) => error?.subtype === 'ads.write_rejected',
  );
});

test('a partially failed multistatus response is surfaced instead of being marked successful', async () => {
  const ctx = {
    flags: { ...createFlags },
    progress() {},
    adsClient: {
      async request() {
        return {
          campaigns: {
            success: [{ campaignId: '456' }],
            error: [{ errors: [{ errorType: 'otherError' }] }],
          },
        };
      },
    },
  };
  await assert.rejects(
    () => adsCampaignCreate.execute(ctx),
    (error) => error?.subtype === 'ads.write_partial_failure',
  );
});

test('a rejected keyword bid update is an error even when the readback matches the requested bid', async () => {
  let readbacks = 0;
  const ctx = {
    flags: { profileId: '123', keywordId: '8100', bid: '0.8' },
    progress() {},
    adsClient: {
      async request(method) {
        if (method === 'PUT') {
          return { keywords: { success: [], error: [{ errors: [{ errorType: 'entityStateError' }] }] } };
        }
        readbacks += 1;
        return { keywords: [{ keywordId: '8100', bid: 0.8 }] };
      },
    },
  };
  await assert.rejects(
    () => adsKeywordBid.execute(ctx),
    (error) => error?.subtype === 'ads.write_rejected',
  );
  assert.equal(readbacks, 0, 'a rejected write must fail before the readback can mask it');
});

test('a rejected campaign state change is an error instead of a success envelope', async () => {
  const ctx = {
    flags: { profileId: '123', campaignId: '9001', state: 'ENABLED' },
    progress() {},
    adsClient: {
      async request(method) {
        if (method === 'PUT') {
          return { campaigns: { success: [], error: [{ errors: [{ errorType: 'entityStateError' }] }] } };
        }
        return { campaigns: [{ campaignId: '9001', state: 'ENABLED' }] };
      },
    },
  };
  await assert.rejects(
    () => adsCampaignState.execute(ctx),
    (error) => error?.subtype === 'ads.write_rejected',
  );
});

test('an unchanged daily budget is rejected at preview time so no token can be issued', async () => {
  const ctx = {
    flags: { profileId: '123', campaignId: '9001', dailyBudget: '10' },
    progress() {},
    confirmationState: { campaignId: '9001', name: 'Same', state: 'PAUSED', budget: { budget: 10 } },
    adsClient: {},
  };
  await assert.rejects(
    () => adsCampaignBudget.dryRun(ctx),
    (error) => error?.subtype === 'ads.no_change_needed' && /已等于目标值/.test(error?.hintHuman ?? ''),
  );
});

test('an unchanged campaign state is rejected at preview time so no token can be issued', async () => {
  const ctx = {
    flags: { profileId: '123', campaignId: '9001', state: 'PAUSED' },
    progress() {},
    confirmationState: { campaignId: '9001', name: 'Same', state: 'PAUSED' },
    adsClient: {},
  };
  await assert.rejects(
    () => adsCampaignState.dryRun(ctx),
    (error) => error?.subtype === 'ads.no_change_needed',
  );
});

test('keyword-bid 写入前两位小数归一,回读同口径比较不再误报 mismatch', async () => {
  let putBody;
  const ctx = {
    // 0.855 归一(round2)后为 0.86:写入与回读比较必须用同一个归一值
    flags: { profileId: '123', keywordId: '8100', bid: '0.855' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (method === 'PUT') {
          putBody = opts.body;
          return { keywords: { success: [{ keywordId: '8100' }], error: [] } };
        }
        return { keywords: [{ keywordId: '8100', bid: 0.86 }] };
      },
    },
  };
  const result = await adsKeywordBid.execute(ctx);
  assert.equal(putBody.keywords[0].bid, 0.86);
  assert.equal(result.verificationStatus, 'VERIFIED');
});

test('keyword-bid 预览:目标竞价归一后与当前相等 → 判 no-change,拒发令牌', async () => {
  const ctx = {
    flags: { profileId: '123', keywordId: '8100', bid: '0.855' },
    progress() {},
    // 目标 0.855 归一后 = 0.86,与当前值相同 → 应判 no-change
    confirmationState: { keywordId: '8100', bid: 0.86, keywordText: 'kw', state: 'ENABLED' },
    adsClient: {},
  };
  await assert.rejects(
    () => adsKeywordBid.dryRun(ctx),
    (error) => error?.subtype === 'ads.no_change_needed',
  );
});

test('campaign-budget 写入前两位小数归一,回读同口径比较不再误报 mismatch', async () => {
  let putBody;
  const ctx = {
    flags: { profileId: '123', campaignId: '9001', dailyBudget: '12.345' },
    progress() {},
    adsClient: {
      async request(method, path, opts) {
        if (method === 'PUT') {
          putBody = opts.body;
          return { campaigns: { success: [{ campaignId: '9001' }], error: [] } };
        }
        return { campaigns: [{ campaignId: '9001', name: 'C', budget: { budget: 12.35 } }] };
      },
    },
  };
  const result = await adsCampaignBudget.execute(ctx);
  assert.equal(putBody.campaigns[0].budget.budget, 12.35);
  assert.equal(result.verificationStatus, 'VERIFIED');
});
