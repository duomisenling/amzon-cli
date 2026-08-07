import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  extractAccountArg,
  loadAccount,
  loadDotEnvIfPresent,
  parseEnvText,
} from '../dist/internal/account.js';

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = join(tmpdir(), `amz-cli-account-${process.pid}-${Date.now()}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

test('multi-store account env example is self-contained and has no Broker settings', () => {
  const account = parseEnvText(
    readFileSync(join(process.cwd(), 'examples', 'env', 'account.env.example'), 'utf8'),
  );

  assert.deepEqual(Object.keys(account), [
    'LWA_CLIENT_ID',
    'LWA_CLIENT_SECRET',
    'LWA_REFRESH_TOKEN_NA',
    'LWA_REFRESH_TOKEN_EU',
    'LWA_REFRESH_TOKEN_FE',
    'SELLER_ID_NA',
    'SELLER_ID_EU',
    'SELLER_ID_FE',
    'SP_API_REGION',
    'SP_API_SANDBOX',
    'SP_API_USER_AGENT',
    'ADS_USER_AGENT',
    'ADS_CLIENT_ID',
    'ADS_CLIENT_SECRET',
    'ADS_REFRESH_TOKEN',
    'ADS_REGION',
    // 代理配置:留空 = 直连,所以模板里三项都必须是空值。
    'SP_API_PROXY',
    'ADS_PROXY',
    'EGRESS_LABEL',
  ]);
  assert.equal(account.SP_API_REGION, 'na');
  assert.equal(account.SP_API_SANDBOX, 'false');
  assert.equal(account.ADS_REGION, 'na');
  for (const [key, value] of Object.entries(account)) {
    if (!['SP_API_REGION', 'SP_API_SANDBOX', 'ADS_REGION'].includes(key)) assert.equal(value, '');
  }
  for (const forbidden of ['BROKER_URL', 'TEAM_TOKEN', 'STORE']) {
    assert.equal(forbidden in account, false);
  }
});

test('rejects an empty --account= value instead of using the default account', () => {
  const argv = ['node', 'dist/cli.js', '--account=', 'sales', 'stats'];
  assert.throws(
    () => extractAccountArg(argv),
    (error) => error?.subtype === 'account_missing_value',
  );
});

test('loads shared Broker settings before switching STORE', () => {
  const cwd = tempRoot();
  const home = tempRoot();
  writeFileSync(
    join(cwd, '.env'),
    'BROKER_URL=https://broker.example.test\nTEAM_TOKEN=team-token\nSTORE=DEFAULT\nSELLER_ID=OLD\n',
  );
  const env = {};
  loadDotEnvIfPresent(env, cwd);
  loadAccount('shop-b', { env, home, stderr: () => {} });

  assert.equal(env.BROKER_URL, 'https://broker.example.test');
  assert.equal(env.TEAM_TOKEN, 'team-token');
  assert.equal(env.STORE, 'SHOP_B');
  assert.equal(env.SELLER_ID, undefined);
});

test('账号名大小写不敏感:小写 shopa 匹配 ShopA.env 并归一到规范名', () => {
  const home = tempRoot();
  mkdirSync(join(home, '.amz-cli', 'accounts'), { recursive: true });
  writeFileSync(
    join(home, '.amz-cli', 'accounts', 'ShopA.env'),
    'LWA_CLIENT_ID=a-client\nSELLER_ID_NA=A_SELLER_X\n',
  );
  const env = {};
  const canonical = loadAccount('shopa', { env, home, stderr: () => {} });
  assert.equal(canonical, 'ShopA'); // 返回文件实际大小写(规范名),供审计/路由统一使用
  assert.equal(env.LWA_CLIENT_ID, 'a-client');
  assert.equal(env.SELLER_ID_NA, 'A_SELLER_X');
});

test('精确大小写仍然优先命中,返回原名', () => {
  const home = tempRoot();
  mkdirSync(join(home, '.amz-cli', 'accounts'), { recursive: true });
  writeFileSync(join(home, '.amz-cli', 'accounts', 'A.env'), 'SELLER_ID_NA=A_SELLER\n');
  const env = {};
  assert.equal(loadAccount('A', { env, home, stderr: () => {} }), 'A');
  assert.equal(env.SELLER_ID_NA, 'A_SELLER');
});

test('切换账号时清空上一个账号的代理配置,不会串到下一个', () => {
  const home = tempRoot();
  const dir = join(home, '.amz-cli', 'accounts');
  mkdirSync(dir, { recursive: true });
  // A 配了代理;B 是"就要直连"的账号,故意不配
  writeFileSync(
    join(dir, 'ShopA.env'),
    'SELLER_ID_NA=A\nSP_API_PROXY=http://u:p@1.1.1.1:38128\nADS_PROXY=http://u:p@2.2.2.2:38128\nEGRESS_LABEL=shop-a\n',
  );
  writeFileSync(join(dir, 'ShopB.env'), 'SELLER_ID_NA=B\n');

  const env = {};
  loadAccount('ShopA', { env, home, stderr: () => {} });
  assert.equal(env.SP_API_PROXY, 'http://u:p@1.1.1.1:38128');
  assert.equal(env.EGRESS_LABEL, 'shop-a');

  // 切到 B:三项都必须被清掉,否则 B 会用上 A 的代理
  loadAccount('ShopB', { env, home, stderr: () => {} });
  assert.equal(env.SELLER_ID_NA, 'B');
  assert.equal(env.SP_API_PROXY, undefined, 'A 的代理串到了 B');
  assert.equal(env.ADS_PROXY, undefined, 'A 的广告代理串到了 B');
  assert.equal(env.EGRESS_LABEL, undefined, 'A 的出口标签串到了 B');
});

test('切换账号时清空区域/沙盒/UA 设置,账号文件省略的项落回默认而不是继承', () => {
  const home = tempRoot();
  const dir = join(home, '.amz-cli', 'accounts');
  mkdirSync(dir, { recursive: true });
  // A 开了沙盒、配了自己的区域和 UA;B 的文件省略了这些行
  writeFileSync(
    join(dir, 'ShopA.env'),
    'SELLER_ID_NA=A\nSP_API_SANDBOX=true\nSP_API_REGION=eu\nADS_REGION=eu\n' +
      'SP_API_USER_AGENT=AppA/1.0\nADS_USER_AGENT=AppA-Ads/1.0\n',
  );
  writeFileSync(join(dir, 'ShopB.env'), 'SELLER_ID_NA=B\n');

  const env = {};
  loadAccount('ShopA', { env, home, stderr: () => {} });
  assert.equal(env.SP_API_SANDBOX, 'true');

  // 切到 B:最危险的是 SP_API_SANDBOX 残留 —— B 的请求会整个打到沙盒
  loadAccount('ShopB', { env, home, stderr: () => {} });
  assert.equal(env.SELLER_ID_NA, 'B');
  assert.equal(env.SP_API_SANDBOX, undefined, 'A 的沙盒开关串到了 B');
  assert.equal(env.SP_API_REGION, undefined, 'A 的区域串到了 B');
  assert.equal(env.ADS_REGION, undefined, 'A 的广告区域串到了 B');
  assert.equal(env.SP_API_USER_AGENT, undefined, 'A 的 UA 串到了 B');
  assert.equal(env.ADS_USER_AGENT, undefined, 'A 的广告 UA 串到了 B');
});

test('共享 .env 里误配的代理不会污染指定账号', () => {
  const home = tempRoot();
  const dir = join(home, '.amz-cli', 'accounts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'DirectShop.env'), 'SELLER_ID_NA=D\n');

  // 管理员手滑把代理写进了共享配置/系统环境变量
  const env = { SP_API_PROXY: 'http://oops:p@9.9.9.9:38128', EGRESS_LABEL: 'wrong' };
  loadAccount('DirectShop', { env, home, stderr: () => {} });
  assert.equal(env.SP_API_PROXY, undefined, '共享配置的代理污染了本该直连的账号');
  assert.equal(env.EGRESS_LABEL, undefined);
});

test('falls back to the user config when cwd has no amz-cli settings', () => {
  const cwd = tempRoot();
  const home = tempRoot();
  mkdirSync(join(home, '.amz-cli'), { recursive: true });
  writeFileSync(
    join(home, '.amz-cli', '.env'),
    'LWA_CLIENT_ID=user-client\nLWA_REFRESH_TOKEN_NA=user-token\nSELLER_ID_NA=USER_SELLER\n',
  );
  writeFileSync(join(cwd, '.env'), 'UNRELATED_SETTING=keep-this-project-only\n');

  const env = {};
  loadDotEnvIfPresent(env, cwd, home);

  assert.equal(env.LWA_CLIENT_ID, 'user-client');
  assert.equal(env.LWA_REFRESH_TOKEN_NA, 'user-token');
  assert.equal(env.SELLER_ID_NA, 'USER_SELLER');
  assert.equal(env.UNRELATED_SETTING, undefined);
});

test('project amz-cli config is isolated and never inherits missing identity from user config', () => {
  const cwd = tempRoot();
  const home = tempRoot();
  mkdirSync(join(home, '.amz-cli'), { recursive: true });
  writeFileSync(
    join(home, '.amz-cli', '.env'),
    'BROKER_URL=https://broker.example.test\nTEAM_TOKEN=user-team\nSTORE=USER_STORE\n',
  );
  writeFileSync(
    join(cwd, '.env'),
    'LWA_CLIENT_ID=project-client\nLWA_REFRESH_TOKEN_NA=project-token\n',
  );

  const env = {};
  loadDotEnvIfPresent(env, cwd, home);

  assert.equal(env.LWA_CLIENT_ID, 'project-client');
  assert.equal(env.LWA_REFRESH_TOKEN_NA, 'project-token');
  assert.equal(env.BROKER_URL, undefined);
  assert.equal(env.TEAM_TOKEN, undefined);
  assert.equal(env.STORE, undefined);
});

test('shell environment overrides the selected dotenv file', () => {
  const cwd = tempRoot();
  const home = tempRoot();
  mkdirSync(join(home, '.amz-cli'), { recursive: true });
  writeFileSync(join(home, '.amz-cli', '.env'), 'SP_API_REGION=eu\nSELLER_ID_EU=FILE_SELLER\n');

  const env = { SP_API_REGION: 'na' };
  loadDotEnvIfPresent(env, cwd, home);

  assert.equal(env.SP_API_REGION, 'na');
  assert.equal(env.SELLER_ID_EU, 'FILE_SELLER');
});

test('AMZ_CLI_SKIP_DOTENV disables both project and user config loading', () => {
  const cwd = tempRoot();
  const home = tempRoot();
  mkdirSync(join(home, '.amz-cli'), { recursive: true });
  writeFileSync(join(home, '.amz-cli', '.env'), 'LWA_CLIENT_ID=should-not-load\n');

  const env = { AMZ_CLI_SKIP_DOTENV: 'true' };
  loadDotEnvIfPresent(env, cwd, home);
  assert.equal(env.LWA_CLIENT_ID, undefined);
});

test('a local account cannot inherit another account application, tokens, or Seller IDs', () => {
  const home = tempRoot();
  const accountDir = join(home, '.amz-cli', 'accounts');
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(
    join(accountDir, 'shop-b.env'),
    'LWA_CLIENT_ID=shop-b-client\nLWA_CLIENT_SECRET=shop-b-secret\n' +
      'LWA_REFRESH_TOKEN_NA=shop-b-na\nSELLER_ID_NA=SHOP_B\n',
  );

  const env = {
    LWA_CLIENT_ID: 'shared-client',
    LWA_CLIENT_SECRET: 'shared-secret',
    LWA_REFRESH_TOKEN_NA: 'shop-a-na',
    LWA_REFRESH_TOKEN_EU: 'shop-a-eu',
    SELLER_ID_NA: 'SHOP_A_NA',
    SELLER_ID_EU: 'SHOP_A_EU',
    ADS_REFRESH_TOKEN: 'shop-a-ads',
    ADS_CLIENT_ID: 'shop-a-ads-client',
    ADS_CLIENT_SECRET: 'shop-a-ads-secret',
    BROKER_URL: 'https://broker.example.test',
    TEAM_TOKEN: 'team-token',
    STORE: 'SHOP_A',
  };
  loadAccount('shop-b', { env, home, stderr: () => {} });

  assert.equal(env.LWA_REFRESH_TOKEN_NA, 'shop-b-na');
  assert.equal(env.LWA_CLIENT_ID, 'shop-b-client');
  assert.equal(env.LWA_CLIENT_SECRET, 'shop-b-secret');
  assert.equal(env.SELLER_ID_NA, 'SHOP_B');
  assert.equal(env.LWA_REFRESH_TOKEN_EU, undefined);
  assert.equal(env.SELLER_ID_EU, undefined);
  assert.equal(env.ADS_REFRESH_TOKEN, undefined);
  assert.equal(env.ADS_CLIENT_ID, undefined);
  assert.equal(env.ADS_CLIENT_SECRET, undefined);
  assert.equal(env.BROKER_URL, undefined);
  assert.equal(env.TEAM_TOKEN, undefined);
  assert.equal(env.STORE, undefined);
});

test('auth whoami passes --region through to the SP-API client and reports it', async () => {
  const { authWhoami } = await import('../dist/shortcuts/auth/whoami.js');
  const calls = [];
  const ctx = {
    flags: { region: 'eu' },
    progress() {},
    client: {
      async get(path, query, region) {
        calls.push({ path, region });
        return {
          payload: [
            {
              marketplace: { id: 'A1PA6795UKMFR9', countryCode: 'DE', name: 'Amazon.de' },
              participation: { isParticipating: true },
            },
          ],
        };
      },
    },
  };
  const result = await authWhoami.execute(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].region, 'eu');
  assert.equal(result.region, 'eu');
  assert.equal(result.markets[0].country, 'DE');
});

test('auth whoami without --region queries the default region and says which one', async () => {
  const { authWhoami } = await import('../dist/shortcuts/auth/whoami.js');
  const saved = process.env.SP_API_REGION;
  delete process.env.SP_API_REGION;
  try {
    const calls = [];
    const ctx = {
      flags: {},
      progress() {},
      client: {
        async get(path, query, region) {
          calls.push({ region });
          return { payload: [] };
        },
      },
    };
    const result = await authWhoami.execute(ctx);
    assert.equal(calls[0].region, undefined);
    assert.equal(result.region, 'na');
    assert.match(result.note, /--region/);
  } finally {
    if (saved !== undefined) process.env.SP_API_REGION = saved;
  }
});
