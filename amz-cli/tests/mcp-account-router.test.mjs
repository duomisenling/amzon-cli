import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  MultiAccountMcpRouter,
  createStdioAccountConnector,
} from '../dist/mcp/account-router.js';
import { createAmazonMcpServer } from '../dist/mcp-server.js';

let stateDir;

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  delete process.env.AMZ_MCP_ALLOW_WRITES;
  delete process.env.AMZ_MCP_ALLOWED_WRITES;
  delete process.env.SELLER_ID;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

function plan(launchId = 'router-launch-001') {
  return {
    version: 1,
    launchId,
    profileId: '123456789',
    region: 'eu',
    marketplace: 'FR',
    campaign: {
      name: 'Router test',
      dailyBudget: 30,
      startDate: '2026-08-01',
      biddingStrategy: 'LEGACY_FOR_SALES',
    },
    adGroup: { name: 'Keywords', defaultBid: 0.5 },
    product: { sku: 'SKU-1', asin: 'B012345678' },
    keywords: [{ text: 'soap bar', matchType: 'EXACT', bid: 0.5 }],
    enableAfterCreate: false,
  };
}

function inMemoryConnector(factoriesFor = () => ({})) {
  return async (account) => {
    process.env.SELLER_ID = 'SELLER';
    const server = createAmazonMcpServer(
      {
        spClient: () => ({
          get: async () => ({ items: [{ sku: 'SKU-1', summaries: [{ asin: 'B012345678' }] }] }),
        }),
        ...factoriesFor(account),
      },
      account,
    );
    const client = new Client({ name: `router-child-test-${account}`, version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      listTools: () => client.listTools(),
      callTool: async (params) => await client.callTool(params),
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };
}

async function connected(accounts, factoriesFor) {
  stateDir = mkdtempSync(join(tmpdir(), 'amz-mcp-router-state-'));
  process.env.AMZ_CLI_STATE_DIR = stateDir;
  const router = new MultiAccountMcpRouter(accounts, {
    connector: inMemoryConnector(factoriesFor),
    version: '1.0.0-test',
  });
  const client = new Client({ name: 'router-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([router.connect(serverTransport), client.connect(clientTransport)]);
  return { client, router };
}

test('combined MCP exposes one tool set whose every tool requires an allowed account', async () => {
  const accounts = ['shop-a', 'shop-b', 'shop-d'];
  const { client, router } = await connected(accounts);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.properties.account.type, 'string');
      assert.deepEqual(tool.inputSchema.properties.account.enum, accounts);
      assert.ok(tool.inputSchema.required.includes('account'));
      assert.match(tool.title, /多店铺/);
    }

    const prepared = await client.callTool({
      name: 'prepare_keyword_campaign',
      arguments: { account: 'shop-b', plan: plan() },
    });
    assert.equal(prepared.isError, undefined);
    assert.equal(prepared.structuredContent.account, 'shop-b');
  } finally {
    await client.close();
    await router.close();
  }
});

test('combined MCP rejects missing/unknown accounts, but routes case-insensitively', async () => {
  const { client, router } = await connected(['shop-b', 'shop-d']);
  try {
    await assert.rejects(
      client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan('missing') } }),
      /account/,
    );
    await assert.rejects(
      client.callTool({
        name: 'prepare_keyword_campaign',
        arguments: { account: 'Unknown', plan: plan('unknown') },
      }),
      /account/,
    );
    // 大小写不敏感:大写 SHOP-B 归一到配置里的 shop-b 并正常路由,不再被拒。
    const prepared = await client.callTool({
      name: 'prepare_keyword_campaign',
      arguments: { account: 'SHOP-B', plan: plan('case-insensitive') },
    });
    assert.equal(prepared.structuredContent.account, 'shop-b');
  } finally {
    await client.close();
    await router.close();
  }
});

test('preview token prepared for one account cannot be applied through another account', async () => {
  let adsClientCreated = false;
  const { client, router } = await connected(['shop-b', 'shop-d'], () => ({
    adsClient: () => {
      adsClientCreated = true;
      throw new Error('cross-account token must fail before creating an Ads client');
    },
  }));
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  process.env.AMZ_MCP_ALLOWED_WRITES = 'ads.keyword-campaign-launch';
  try {
    const campaignPlan = plan('cross-account');
    const prepared = await client.callTool({
      name: 'prepare_keyword_campaign',
      arguments: { account: 'shop-b', plan: campaignPlan },
    });
    const applied = await client.callTool({
      name: 'launch_keyword_campaign',
      arguments: {
        account: 'shop-d',
        plan: campaignPlan,
        previewToken: prepared.structuredContent.previewToken,
      },
    });

    assert.equal(applied.isError, true);
    assert.equal(adsClientCreated, false);
    assert.match(applied.content[0].text, /preview|预览|snapshot|令牌/i);
  } finally {
    await client.close();
    await router.close();
  }
});

test('concurrent prepares remain routed to their explicitly selected accounts', async () => {
  const { client, router } = await connected(['shop-b', 'shop-d']);
  try {
    const [shopBResult, shopDResult] = await Promise.all([
      client.callTool({
        name: 'prepare_keyword_campaign',
        arguments: { account: 'shop-b', plan: plan('concurrent-shop-b') },
      }),
      client.callTool({
        name: 'prepare_keyword_campaign',
        arguments: { account: 'shop-d', plan: plan('concurrent-shop-d') },
      }),
    ]);
    assert.equal(shopBResult.structuredContent.account, 'shop-b');
    assert.equal(shopDResult.structuredContent.account, 'shop-d');
  } finally {
    await client.close();
    await router.close();
  }
});

test('production stdio connector starts a fixed-account child without calling Amazon', async () => {
  const home = mkdtempSync(join(tmpdir(), 'amz-mcp-router-home-'));
  const accountDir = join(home, '.amz-cli', 'accounts');
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(join(accountDir, 'shop-b.env'), '# tool listing needs no credentials\n', 'utf8');
  const env = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: home,
    HOME: home,
    AMZ_CLI_SKIP_DOTENV: 'true',
  };
  const connectAccount = createStdioAccountConnector({
    serverPath: join(process.cwd(), 'dist', 'mcp-server.js'),
    env,
    version: '1.0.0-test',
  });
  const child = await connectAccount('shop-b');
  try {
    const listed = await child.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'prepare_listing_update'));
  } finally {
    await child.close();
    rmSync(home, { recursive: true, force: true });
  }
});
