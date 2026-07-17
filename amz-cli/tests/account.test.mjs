import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { extractAccountArg, loadAccount, loadDotEnvIfPresent } from '../dist/internal/account.js';

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

test('a local account cannot inherit another account region tokens or Seller IDs', () => {
  const home = tempRoot();
  const accountDir = join(home, '.amz-cli', 'accounts');
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(join(accountDir, 'shop-b.env'), 'LWA_REFRESH_TOKEN_NA=shop-b-na\nSELLER_ID_NA=SHOP_B\n');

  const env = {
    LWA_CLIENT_ID: 'shared-client',
    LWA_CLIENT_SECRET: 'shared-secret',
    LWA_REFRESH_TOKEN_NA: 'shop-a-na',
    LWA_REFRESH_TOKEN_EU: 'shop-a-eu',
    SELLER_ID_NA: 'SHOP_A_NA',
    SELLER_ID_EU: 'SHOP_A_EU',
    ADS_REFRESH_TOKEN: 'shop-a-ads',
    BROKER_URL: 'https://broker.example.test',
    TEAM_TOKEN: 'team-token',
    STORE: 'SHOP_A',
  };
  loadAccount('shop-b', { env, home, stderr: () => {} });

  assert.equal(env.LWA_REFRESH_TOKEN_NA, 'shop-b-na');
  assert.equal(env.SELLER_ID_NA, 'SHOP_B');
  assert.equal(env.LWA_REFRESH_TOKEN_EU, undefined);
  assert.equal(env.SELLER_ID_EU, undefined);
  assert.equal(env.ADS_REFRESH_TOKEN, undefined);
  assert.equal(env.BROKER_URL, undefined);
  assert.equal(env.TEAM_TOKEN, undefined);
  assert.equal(env.STORE, undefined);
  assert.equal(env.LWA_CLIENT_ID, 'shared-client');
  assert.equal(env.LWA_CLIENT_SECRET, 'shared-secret');
});
