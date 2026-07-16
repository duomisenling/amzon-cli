import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SpApiClient } from '../dist/internal/client/client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('non-idempotent POST is not replayed after an ambiguous 5xx', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [{ message: 'temporary gateway failure' }] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const credentials = {
    async getCredentials() {
      return {
        accessToken: 'short-lived-token',
        endpoint: 'https://sellingpartnerapi-na.amazon.com',
        region: 'na',
      };
    },
  };
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('POST', '/feeds/2021-06-30/feeds', { body: { feedType: 'x' } }),
    (error) => error?.subtype === 'sp_api.write_result_unknown' && error?.hintAgent === 'report_to_human',
  );
  assert.equal(calls, 1);
});
