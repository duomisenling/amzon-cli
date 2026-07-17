import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { readPackageInfo } from '../dist/internal/package-info.js';
import { initUserConfig, userConfigPath } from '../dist/setup/config.js';
import { createInstallPlan, installAmzCli } from '../dist/setup/install.js';

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
