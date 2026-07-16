import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { brokerConfigFromEnv, mintFromBroker } from '../dist/internal/credential/broker.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BROKER_URL;
  delete process.env.TEAM_TOKEN;
  delete process.env.STORE;
  delete process.env.SP_API_SANDBOX;
});

const cfg = {
  brokerUrl: 'https://broker.example.test',
  teamToken: 'test-token',
  store: 'TEST_STORE',
  region: 'na',
};

function mockMintResponse(body) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

test('rejects a non-Amazon endpoint returned by Broker', async () => {
  mockMintResponse({
    access_token: 'short-lived-token',
    expires_in: 3600,
    endpoint: 'https://custom.example.test',
  });

  await assert.rejects(
    () => mintFromBroker(cfg, 'sp-api', 'eu'),
    (error) => error?.subtype === 'broker.invalid_endpoint',
  );
});

test('SP-API fallback follows the requested region', async () => {
  mockMintResponse({ access_token: 'short-lived-token', expires_in: 3600 });

  const result = await mintFromBroker(cfg, 'sp-api', 'eu');
  assert.equal(result.endpoint, 'https://sellingpartnerapi-eu.amazon.com');
});

test('Ads fallback uses the Ads endpoint for the requested region', async () => {
  mockMintResponse({
    access_token: 'short-lived-token',
    expires_in: 3600,
    client_id: 'public-client-id',
  });

  const eu = await mintFromBroker(cfg, 'ads', 'eu');
  assert.equal(eu.endpoint, 'https://advertising-api-eu.amazon.com');

  mockMintResponse({
    access_token: 'short-lived-token',
    expires_in: 3600,
    client_id: 'public-client-id',
  });
  const na = await mintFromBroker(cfg, 'ads');
  assert.equal(na.endpoint, 'https://advertising-api.amazon.com');
});

test('Broker configuration rejects insecure remote HTTP', () => {
  process.env.BROKER_URL = 'http://broker.example.test';
  process.env.TEAM_TOKEN = 'team-token';
  process.env.STORE = 'TEST';
  assert.throws(
    () => brokerConfigFromEnv(),
    (error) => error?.subtype === 'broker.https_required',
  );
});

test('Broker mode fails closed when sandbox is requested', () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  process.env.TEAM_TOKEN = 'team-token';
  process.env.STORE = 'TEST';
  process.env.SP_API_SANDBOX = 'true';
  assert.throws(
    () => brokerConfigFromEnv(),
    (error) => error?.subtype === 'broker.sandbox_not_supported',
  );
});
