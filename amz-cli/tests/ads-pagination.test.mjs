import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsCampaigns } from '../dist/shortcuts/ads/commands.js';
import { adsKeywords } from '../dist/shortcuts/ads/keywords.js';

function context(flags, response) {
  let request;
  return {
    ctx: {
      flags,
      progress() {},
      adsClient: {
        async request(method, path, options) {
          request = { method, path, options };
          return response;
        },
      },
    },
    getRequest: () => request,
  };
}

test('ads campaigns passes nextToken and exposes the following cursor', async () => {
  const setup = context(
    { profileId: '123', max: '25', nextToken: 'page-2' },
    { campaigns: [{ campaignId: '1' }], nextToken: 'page-3' },
  );
  const result = await adsCampaigns.execute(setup.ctx);
  assert.equal(setup.getRequest().options.body.nextToken, 'page-2');
  assert.equal(setup.getRequest().options.body.maxResults, 25);
  assert.equal(result.nextToken, 'page-3');
});

test('ads keywords passes nextToken and rejects invalid page size locally', async () => {
  assert.throws(
    () => adsKeywords.validate({ profileId: '123', max: 'NaN' }),
    (error) => error?.subtype === 'invalid_number',
  );
  const setup = context(
    { profileId: '123', nextToken: 'page-2' },
    { keywords: [], nextToken: 'page-3' },
  );
  const result = await adsKeywords.execute(setup.ctx);
  assert.equal(setup.getRequest().options.body.nextToken, 'page-2');
  assert.equal(result.nextToken, 'page-3');
});
