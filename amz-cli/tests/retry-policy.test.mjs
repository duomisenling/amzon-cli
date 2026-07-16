import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SpApiClient } from '../dist/internal/client/client.js';
import { AdsClient } from '../dist/internal/client/ads-client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BROKER_URL;
  delete process.env.TEAM_TOKEN;
  delete process.env.STORE;
});

const credentials = {
  async getCredentials() {
    return {
      accessToken: 'short-lived-token',
      endpoint: 'https://sellingpartnerapi-na.amazon.com',
      region: 'na',
    };
  },
};

test('non-idempotent POST is not replayed after an ambiguous 5xx', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [{ message: 'temporary gateway failure' }] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('POST', '/feeds/2021-06-30/feeds', { body: { feedType: 'x' } }),
    (error) => error?.subtype === 'sp_api.write_result_unknown' && error?.hintAgent === 'report_to_human',
  );
  assert.equal(calls, 1);
});

test('SP write network failure is reported as unknown and never marked retryable', async () => {
  globalThis.fetch = async () => {
    throw new DOMException('request timed out', 'AbortError');
  };
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('PATCH', '/listings/2021-08-01/items/seller/sku', { body: {} }),
    (error) =>
      error?.subtype === 'sp_api.write_result_unknown' &&
      error?.hintAgent === 'report_to_human' &&
      error?.retryable === false,
  );
});

test('SP write with an invalid successful response is not presented as retryable', async () => {
  globalThis.fetch = async () => new Response('<bad gateway html>', { status: 200 });
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('POST', '/feeds/2021-06-30/feeds', { body: {} }),
    (error) => error?.subtype === 'sp_api.write_result_unknown' && error?.retryable === false,
  );
});

test('Ads write network failure is reported as unknown and never marked retryable', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  process.env.TEAM_TOKEN = 'team-token';
  process.env.STORE = 'SHOP';
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    if (new URL(input).hostname === 'broker.example.test') {
      return new Response(
        JSON.stringify({
          access_token: 'short-lived-token',
          expires_in: 3600,
          endpoint: 'https://advertising-api.amazon.com',
          client_id: 'public-client-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new DOMException('request timed out', 'AbortError');
  };

  const client = new AdsClient();
  await assert.rejects(
    () => client.request('PUT', '/sp/campaigns', { profileId: '123', body: {} }),
    (error) =>
      error?.subtype === 'ads.write_result_unknown' &&
      error?.hintAgent === 'report_to_human' &&
      error?.retryable === false,
  );
  assert.equal(calls, 2);
});

test('Ads write with an invalid successful response is not presented as retryable', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  process.env.TEAM_TOKEN = 'team-token';
  process.env.STORE = 'SHOP';
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === 'broker.example.test') {
      return new Response(
        JSON.stringify({
          access_token: 'short-lived-token',
          expires_in: 3600,
          endpoint: 'https://advertising-api.amazon.com',
          client_id: 'public-client-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('<bad gateway html>', { status: 200 });
  };

  const client = new AdsClient();
  await assert.rejects(
    () => client.request('POST', '/sp/negativeKeywords', { profileId: '123', body: {} }),
    (error) => error?.subtype === 'ads.write_result_unknown' && error?.retryable === false,
  );
});
