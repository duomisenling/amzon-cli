import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { auditLog, setAuditOperation } from '../dist/internal/audit.js';
import { MultiAccountMcpRouter } from '../dist/mcp/account-router.js';
import { createAmazonMcpServer, extractAccountsArg } from '../dist/mcp-server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let stateDir;

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  delete process.env.AMZ_MCP_ALLOW_WRITES;
  delete process.env.AMZ_MCP_ALLOWED_WRITES;
  delete process.env.SELLER_ID;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

function plan() {
  return {
    version: 1,
    launchId: 'mcp-launch-001',
    profileId: '123456789',
    region: 'na',
    marketplace: 'US',
    campaign: {
      name: 'MCP test',
      dailyBudget: 10,
      startDate: '2026-08-01',
      biddingStrategy: 'LEGACY_FOR_SALES',
    },
    adGroup: { name: 'Keywords', defaultBid: 0.5 },
    product: { sku: 'SKU-1', asin: 'B012345678' },
    keywords: [{ text: 'soap bar', matchType: 'EXACT', bid: 0.5 }],
    enableAfterCreate: false,
  };
}

test('MCP startup extracts and validates a combined account allowlist', () => {
  const argv = ['node', 'mcp-server.js', '--accounts', 'shop-a,shop-b,shop-d'];
  assert.deepEqual(extractAccountsArg(argv), ['shop-a', 'shop-b', 'shop-d']);
  assert.deepEqual(argv, ['node', 'mcp-server.js']);
  assert.throws(
    () => extractAccountsArg(['node', 'mcp-server.js', '--accounts=']),
    (error) => error?.subtype === 'mcp_accounts_missing_value',
  );
  assert.throws(
    () => extractAccountsArg(['node', 'mcp-server.js', '--accounts=,,,']),
    (error) => error?.subtype === 'mcp_accounts_missing_value',
  );
});

async function connected(clientFactory, account = 'default', spItems = [{ sku: 'SKU-1', summaries: [{ asin: 'B012345678' }] }]) {
  stateDir = mkdtempSync(join(tmpdir(), 'amz-mcp-test-'));
  process.env.AMZ_CLI_STATE_DIR = stateDir;
  process.env.SELLER_ID = 'SELLER';
  const server = createAmazonMcpServer(
    {
      adsClient: clientFactory,
      spClient: () => ({
        get: async () => ({ items: typeof spItems === 'function' ? spItems() : spItems }),
      }),
    },
    account,
  );
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
    assert.equal(prepare.inputSchema.properties.plan.required.includes('marketplace'), true);
    assert.equal(prepare.inputSchema.properties.plan.required.includes('products'), true);
    assert.equal(prepare.inputSchema.properties.plan.properties.products.items.required.includes('sku'), true);
    assert.equal(
      prepare.inputSchema.properties.plan.properties.products.items.properties.asin.description.includes('不会发送'),
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP prepare rejects an unverified SKU before creating an Ads client or preview token', async () => {
  let adsClientCreated = false;
  const { client, server } = await connected(
    () => {
      adsClientCreated = true;
      throw new Error('must not create Ads client when SKU preflight fails');
    },
    'shop-a',
    [],
  );
  try {
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    assert.equal(prepared.isError, true);
    assert.equal(adsClientCreated, false);
    assert.match(prepared.content[0].text, /SKU-1|sku_not_in_store/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP launch rechecks SKU ownership before consuming the preview or creating an Ads client', async () => {
  process.env.AMZ_MCP_ALLOW_WRITES = 'true';
  let currentItems = [{ sku: 'SKU-1', summaries: [{ asin: 'B012345678' }] }];
  let adsClientCreated = false;
  const { client, server } = await connected(
    () => {
      adsClientCreated = true;
      throw new Error('must not create Ads client when launch preflight fails');
    },
    'shop-a',
    () => currentItems,
  );
  try {
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    assert.equal(prepared.isError, undefined);

    currentItems = [];
    const launched = await client.callTool({
      name: 'launch_keyword_campaign',
      arguments: { plan: plan(), previewToken: prepared.structuredContent.previewToken },
    });
    assert.equal(launched.isError, true);
    assert.equal(adsClientCreated, false);
    assert.match(launched.content[0].text, /SKU-1|sku_not_in_store/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP keyword tools expose the fixed account in titles and structured results', async () => {
  const { client, server } = await connected(() => {
    throw new Error('preview must not create AdsClient');
  }, 'shop-a');
  try {
    const listed = await client.listTools();
    const prepare = listed.tools.find((tool) => tool.name === 'prepare_keyword_campaign');
    assert.match(prepare.title, /shop-a/);
    assert.match(prepare.description, /shop-a/);

    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    assert.equal(prepared.isError, undefined);
    assert.equal(prepared.structuredContent.account, 'shop-a');
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP prepare performs only SKU read preflight and launch stays disabled by default', async () => {
  let clientsCreated = 0;
  const { client, server } = await connected(() => {
    clientsCreated += 1;
    throw new Error('AdsClient must not be created');
  });
  try {
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    assert.equal(prepared.isError, undefined);
    assert.equal(clientsCreated, 0);
    assert.equal(prepared.structuredContent.applyAllowed, false);
    assert.match(prepared.structuredContent.applyBlockedReason, /AMZ_MCP_ALLOW_WRITES/);
    assert.match(prepared.structuredContent.nextStep, /无法兑现/);
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

test('MCP 服务版本与 package.json 一致,不再硬编码漂移', async () => {
  const { client, server } = await connected(() => {
    throw new Error('must not create AdsClient');
  });
  try {
    assert.equal(client.getServerVersion().version, pkg.version);
  } finally {
    await client.close();
    await server.close();
  }
});

test('多店路由 MCP 版本取自 package.json,options.version 仍可覆盖', async () => {
  const connector = async () => {
    throw new Error('initialize 阶段不应连接账号子进程');
  };
  const router = new MultiAccountMcpRouter(['shop-a'], { connector });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([router.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.equal(client.getServerVersion().version, pkg.version);
  } finally {
    await client.close();
    await router.close();
  }

  const overridden = new MultiAccountMcpRouter(['shop-a'], { connector, version: '9.9.9' });
  const client2 = new Client({ name: 'test-client', version: '1.0.0' });
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  await Promise.all([overridden.connect(st2), client2.connect(ct2)]);
  try {
    assert.equal(client2.getServerVersion().version, '9.9.9');
  } finally {
    await client2.close();
    await overridden.close();
  }
});

test('MCP 工具调用会把操作名标进审计(op 不再恒为空)', async () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'amz-mcp-audit-'));
  process.env.AMZ_AUDIT_DIR = auditDir;
  delete process.env.AMZ_AUDIT_HTTP;
  setAuditOperation('');
  const { client, server } = await connected(() => {
    throw new Error('preview must not create AdsClient');
  });
  try {
    const prepared = await client.callTool({ name: 'prepare_keyword_campaign', arguments: { plan: plan() } });
    assert.equal(prepared.isError, undefined);
    // 工具入口已把当前操作名设为 "mcp <工具名>";此后本进程发出的审计行都带上它
    auditLog({ api: 'ads', method: 'POST', path: '/sp/campaigns', status: 200, ok: true });
    const month = new Date().toISOString().slice(0, 7);
    const lines = readFileSync(join(auditDir, 'default', `${month}.log`), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines.at(-1)).op, 'mcp prepare_keyword_campaign');
  } finally {
    await client.close();
    await server.close();
    delete process.env.AMZ_AUDIT_DIR;
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('MCP 连接关闭时把尾部审计行上报中央(长驻进程不再永不上报)', async () => {
  process.env.AMZ_AUDIT_DISABLE = '1'; // 只看上报,不落盘
  process.env.AMZ_AUDIT_HTTP = 'https://audit.example.test/ingest';
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: init?.body });
    return new Response('ok');
  };
  const { client, server } = await connected(() => {
    throw new Error('must not create AdsClient');
  });
  try {
    // 模拟长驻期间攒下、但没到批量阈值的尾部审计行
    auditLog({ api: 'sp', method: 'GET', path: '/orders/v0/orders', status: 200, ok: true });
    await client.close();
    await server.close();
    // onclose 里的上报是异步旁路,轮询等它落地
    for (let i = 0; i < 100 && posts.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(posts.length >= 1, '连接关闭后没有触发审计上报');
    assert.match(posts.map((p) => p.body).join('\n'), /\/orders\/v0\/orders/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AMZ_AUDIT_HTTP;
    delete process.env.AMZ_AUDIT_DISABLE;
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
        return { productAds: [{ campaignId: '1001', adGroupId: '2001', adId: '3001', sku: 'SKU-1' }] };
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
