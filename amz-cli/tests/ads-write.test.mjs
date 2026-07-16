import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsCampaignCreate } from '../dist/shortcuts/ads/campaign-create.js';

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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/sp/campaigns');
  assert.equal(result.enabled, false);
  assert.match(result.note, /campaign-state/);
});
