import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAmazonAdsMcpServer } from '../dist/mcp-server.js';

let stateDir;

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  delete process.env.AMZ_MCP_ALLOW_WRITES;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

function plan() {
  return {
    version: 1,
    launchId: 'mcp-launch-001',
    profileId: '123456789',
    region: 'na',
    campaign: {
      name: 'MCP test',
      dailyBudget: 10,
      startDate: '2026-08-01',
      biddingStrategy: 'LEGACY_FOR_SALES',
    },
    adGroup: { name: 'Keywords', defaultBid: 0.5 },
    product: { asin: 'B012345678' },
    keywords: [{ text: 'soap bar', matchType: 'EXACT', bid: 0.5 }],
    enableAfterCreate: false,
  };
}

async function connected(clientFactory) {
  stateDir = mkdtempSync(join(tmpdir(), 'amz-mcp-test-'));
  process.env.AMZ_CLI_STATE_DIR = stateDir;
  const server = createAmazonAdsMcpServer(clientFactory);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('MCP advertises preview as read-only and launch as destructive/non-idempotent', async () => {
  const { client, server } = await connected(() => {
    throw new Error('must not create AdsClient while listing tools');
  });
  try {
    const listed = await client.listTools();
    const prepare = listed.tools.find((tool) => tool.name === 'prepare_keyword_campaign');
    const launch = listed.tools.find((tool) => tool.name === 'launch_keyword_campaign');
    assert.equal(prepare.annotations.readOnlyHint, true);
    assert.equal(launch.annotations.readOnlyHint, false);
    assert.equal(launch.annotations.destructiveHint, true);
    assert.equal(launch.annotations.idempotentHint, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP prepare performs no Amazon call and launch stays disabled by default', async () => {
  let clientsCreated = 0;
  const { client, server } = await connected(() => {
    clientsCreated += 1;
    throw new Error('AdsClient must not be created');
  });
  try {
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    assert.equal(prepared.isError, undefined);
    assert.equal(clientsCreated, 0);
    const token = prepared.structuredContent.previewToken;

    const launched = await client.callTool({
      name: 'launch_keyword_campaign',
      arguments: { plan: plan(), previewToken: token },
    });
    assert.equal(launched.isError, true);
    assert.match(launched.content[0].text, /mcp_writes_disabled/);
    assert.equal(clientsCreated, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP token is bound to the exact reviewed plan', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  let clientsCreated = 0;
  const { client, server } = await connected(() => {
    clientsCreated += 1;
    throw new Error('mismatched plan must fail before AdsClient creation');
  });
  try {
    process.env.AMZ_MCP_ALLOW_WRITES = 'true';
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    const changed = plan();
    changed.campaign.dailyBudget = 99;
    const launched = await client.callTool({
      name: 'launch_keyword_campaign',
      arguments: { plan: changed, previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(launched.isError, true);
    assert.match(launched.content[0].text, /preview_token_mismatch/);
    assert.equal(clientsCreated, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP approved launch consumes the token once and executes the reviewed plan', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  let clientsCreated = 0;
  const calls = [];
  const fakeClient = {
    async request(method, path, opts) {
      calls.push(`${method} ${path}`);
      if (method === 'POST' && path === '/sp/campaigns') {
        assert.equal(opts.body.campaigns[0].state, 'PAUSED');
        return { campaigns: { error: [], success: [{ index: 0, campaignId: '1001' }] } };
      }
      if (path === '/sp/adGroups') return { adGroups: { error: [], success: [{ index: 0, adGroupId: '2001' }] } };
      if (path === '/sp/productAds') return { productAds: { error: [], success: [{ index: 0, adId: '3001' }] } };
      if (path === '/sp/keywords') return { keywords: { error: [], success: [{ index: 0, keywordId: '4001' }] } };
      if (path === '/sp/campaigns/list') return { campaigns: [{ campaignId: '1001', state: 'PAUSED' }] };
      if (path === '/sp/adGroups/list') return { adGroups: [{ campaignId: '1001', adGroupId: '2001' }] };
      if (path === '/sp/productAds/list') {
        return { productAds: [{ campaignId: '1001', adGroupId: '2001', adId: '3001', asin: 'B012345678' }] };
      }
      if (path === '/sp/keywords/list') {
        return { keywords: [{ campaignId: '1001', adGroupId: '2001', keywordId: '4001' }] };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const { client, server } = await connected(() => {
    clientsCreated += 1;
    return fakeClient;
  });
  try {
    process.env.AMZ_MCP_ALLOW_WRITES = 'true';
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    const args = { plan: plan(), previewToken: prepared.structuredContent.previewToken };
    const launched = await client.callTool({ name: 'launch_keyword_campaign', arguments: args });
    assert.equal(launched.isError, undefined);
    assert.equal(launched.structuredContent.state, 'PAUSED');
    assert.equal(calls.includes('PUT /sp/campaigns'), false);
    assert.equal(clientsCreated, 1);

    const replay = await client.callTool({ name: 'launch_keyword_campaign', arguments: args });
    assert.equal(replay.isError, true);
    assert.match(replay.content[0].text, /preview_token_invalid/);
    assert.equal(clientsCreated, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
