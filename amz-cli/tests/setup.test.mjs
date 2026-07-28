import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { readPackageInfo } from '../dist/internal/package-info.js';
import { initUserConfig, userConfigPath } from '../dist/setup/config.js';
import { createInstallPlan, installAmzCli } from '../dist/setup/install.js';
import {
  createCherryMcpConfig,
  parseMcpAccounts,
  writeCherryMcpConfig,
} from '../dist/setup/mcp-config.js';

const execFileAsync = promisify(execFile);
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot(label) {
  const root = join(tmpdir(), `amz-cli-${label}-${process.pid}-${Date.now()}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

test('package metadata is the single source for --version', async () => {
  const info = readPackageInfo();
  const result = await execFileAsync(process.execPath, ['dist/cli.js', '--version'], {
    cwd: process.cwd(),
    env: { AMZ_CLI_SKIP_DOTENV: 'true' },
    windowsHide: true,
  });
  assert.equal(result.stdout.trim(), info.version);
});

test('config init creates a placeholder once and never overwrites it', () => {
  const home = tempRoot('config-home');
  const templateDir = tempRoot('config-template');
  const template = join(templateDir, 'local.env.example');
  writeFileSync(template, 'LWA_CLIENT_ID=\nLWA_CLIENT_SECRET=\n', 'utf8');

  const first = initUserConfig(home, template);
  assert.equal(first.created, true);
  assert.equal(first.path, userConfigPath(home));
  assert.equal(readFileSync(first.path, 'utf8'), 'LWA_CLIENT_ID=\nLWA_CLIENT_SECRET=\n');

  writeFileSync(first.path, 'LWA_CLIENT_ID=do-not-overwrite\n', 'utf8');
  const second = initUserConfig(home, template);
  assert.equal(second.created, false);
  assert.equal(readFileSync(first.path, 'utf8'), 'LWA_CLIENT_ID=do-not-overwrite\n');
});

test('install dry-run describes changes without invoking npm or touching config', () => {
  const home = tempRoot('dry-run-home');
  const info = { name: 'amz-cli', version: '9.8.7' };
  const result = installAmzCli(info, { dryRun: true, home });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.plan, createInstallPlan(info, home));
  assert.equal(result.plan.package, 'amz-cli@9.8.7');
  assert.equal(result.plan.configPath, join(home, '.amz-cli', '.env'));
});

test('installer uses the exact package version and its packaged Skill', () => {
  const home = tempRoot('install-home');
  const globalRoot = tempRoot('global-root');
  const skillDir = join(globalRoot, 'amz-cli', 'skills', 'amz-cli');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: amz-cli\ndescription: test\n---\n');

  const npmCalls = [];
  const npxCalls = [];
  const result = installAmzCli(
    { name: 'amz-cli', version: '1.2.3' },
    {
      home,
      tooling: { npmCli: 'unused-npm', npxCli: 'unused-npx' },
      runNpm(args, capture) {
        npmCalls.push(args);
        return capture ? globalRoot : '';
      },
      runNpx(args) {
        npxCalls.push(args);
      },
      initConfig() {
        return { path: join(home, '.amz-cli', '.env'), created: true };
      },
    },
  );

  assert.deepEqual(npmCalls, [
    ['install', '--global', 'amz-cli@1.2.3'],
    ['root', '--global'],
  ]);
  assert.deepEqual(npxCalls, [
    ['--yes', 'skills', 'add', skillDir, '--yes', '--global'],
  ]);
  assert.equal(result.globalPackageRoot, join(globalRoot, 'amz-cli'));
  assert.equal(result.config.created, true);
});

test('installer fails safely when the published package is missing its Skill', () => {
  const globalRoot = tempRoot('missing-skill');
  assert.throws(
    () =>
      installAmzCli(
        { name: 'amz-cli', version: '1.2.3' },
        {
          tooling: { npmCli: 'unused-npm', npxCli: 'unused-npx' },
          runNpm: (_args, capture) => (capture ? globalRoot : ''),
          runNpx: () => assert.fail('Skill installer must not run for a missing packaged Skill'),
        },
      ),
    (error) => error?.subtype === 'setup.install_failed' && /missing Skill/.test(error.message),
  );
});

test('MCP config generator creates one fixed-account service per store without credentials', () => {
  const root = tempRoot('mcp-config');
  const serverPath = join(root, 'mcp-server.js');
  const output = join(root, 'cherry-mcp.json');
  writeFileSync(serverPath, '// compiled server placeholder\n', 'utf8');

  const accounts = parseMcpAccounts('shop-a, shop_b');
  const config = createCherryMcpConfig(accounts, {
    includeDefault: true,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    serverPath,
  });

  assert.deepEqual(Object.keys(config.mcpServers), [
    'Amazon Safe Writes - 默认账号',
    'Amazon Safe Writes - shop-a',
    'Amazon Safe Writes - shop_b',
  ]);
  assert.deepEqual(config.mcpServers['Amazon Safe Writes - 默认账号'].args, [serverPath]);
  assert.deepEqual(config.mcpServers['Amazon Safe Writes - shop-a'].args, [
    serverPath,
    '--account',
    'shop-a',
  ]);
  assert.equal(
    config.mcpServers['Amazon Safe Writes - shop-a'].env.AMZ_MCP_ALLOWED_WRITES.includes('feed.submit'),
    false,
  );
  assert.equal(JSON.stringify(config).includes('refresh_token'), false);

  assert.equal(writeCherryMcpConfig(output, config), output);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), config);
  assert.throws(
    () => writeCherryMcpConfig(output, config),
    (error) => error?.subtype === 'output_file_exists',
  );
});

test('MCP config generator creates one combined service with an explicit account allowlist', () => {
  const root = tempRoot('mcp-combined');
  const serverPath = join(root, 'mcp-server.js');
  writeFileSync(serverPath, '// compiled server placeholder\n', 'utf8');

  const config = createCherryMcpConfig(['shop-a', 'shop-b', 'shop-d'], {
    combined: true,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    serverPath,
  });

  assert.deepEqual(Object.keys(config.mcpServers), ['Amazon Safe Writes - 多店铺']);
  assert.deepEqual(config.mcpServers['Amazon Safe Writes - 多店铺'].args, [
    serverPath,
    '--accounts',
    'shop-a,shop-b,shop-d',
  ]);
  assert.equal(JSON.stringify(config).includes('refresh_token'), false);
});

test('MCP config generator creates a portable Windows config without machine-specific paths', () => {
  const config = createCherryMcpConfig(
    ['shop-a', 'shop-b', 'shop-c', 'shop-d', 'shop-e'],
    {
      combined: true,
      portable: true,
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      serverPath: 'D:\\private-admin-path\\dist\\mcp-server.js',
    },
  );

  const service = config.mcpServers['Amazon Safe Writes - 多店铺'];
  assert.equal(service.command, 'cmd.exe');
  assert.deepEqual(service.args, [
    '/d',
    '/s',
    '/c',
    'amz-cli-mcp --accounts shop-a,shop-b,shop-c,shop-d,shop-e',
  ]);
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes('Program Files'), false);
  assert.equal(serialized.includes('private-admin-path'), false);
  assert.equal(serialized.includes('refresh_token'), false);
});

test('portable Windows config resolves the installed MCP command from PATH', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows cmd.exe integration');
    return;
  }

  const binDir = tempRoot('portable-mcp-bin');
  writeFileSync(join(binDir, 'amz-cli-mcp.cmd'), '@echo off\r\necho %*\r\n', 'utf8');
  const config = createCherryMcpConfig(['shop-a', 'shop-b'], {
    combined: true,
    portable: true,
  });
  const service = config.mcpServers['Amazon Safe Writes - 多店铺'];
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const systemBin = dirname(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe');
  const result = await execFileAsync(service.command, service.args, {
    env: { ...process.env, [pathKey]: `${binDir};${systemBin};${process.env[pathKey] ?? ''}` },
    windowsHide: true,
  });

  assert.equal(result.stdout.trim(), '--accounts shop-a,shop-b');
});

test('portable MCP config explicitly rejects non-Windows targets', () => {
  assert.throws(
    () => createCherryMcpConfig(['shop-a'], { combined: true, portable: true, platform: 'linux' }),
    (error) => error?.subtype === 'portable_mcp_windows_only',
  );
});

test('MCP config generator rejects missing, invalid, and duplicate account selections', () => {
  const root = tempRoot('mcp-invalid');
  const serverPath = join(root, 'mcp-server.js');
  writeFileSync(serverPath, '// compiled server placeholder\n', 'utf8');

  assert.throws(
    () => createCherryMcpConfig([], { serverPath }),
    (error) => error?.subtype === 'mcp_accounts_required',
  );
  assert.throws(
    () => parseMcpAccounts('shop-a,SHOP-A'),
    (error) => error?.subtype === 'duplicate_account_name',
  );
  assert.throws(
    () => parseMcpAccounts('店铺A'),
    (error) => error?.subtype === 'invalid_account_name',
  );
  assert.throws(
    () => createCherryMcpConfig(['shop-a'], { combined: true, includeDefault: true, serverPath }),
    (error) => error?.subtype === 'combined_mcp_default_unsupported',
  );
});
