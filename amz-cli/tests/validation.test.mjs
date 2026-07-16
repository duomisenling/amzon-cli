import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, ['dist/cli.js', ...args], {
      cwd: process.cwd(),
      env: { AMZ_CLI_SKIP_DOTENV: 'true' },
      windowsHide: true,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function envelope(stderr) {
  const start = stderr.indexOf('{');
  return JSON.parse(stderr.slice(start));
}

test('SP report rejects a non-finite timeout before any API call', async () => {
  const result = await run([
    'report', 'run', '--type', 'GET_MERCHANT_LISTINGS_DATA', '--marketplace', 'US',
    '--timeout', 'Infinity',
  ]);
  assert.equal(result.code, 2);
  assert.equal(envelope(result.stderr).error.subtype, 'invalid_number');
});

test('Ads report rejects NaN timeout before any API call', async () => {
  const result = await run([
    'ads', 'report-run', '--profile-id', '123', '--start', '2026-07-01',
    '--end', '2026-07-02', '--timeout', 'abc',
  ]);
  assert.equal(result.code, 2);
  assert.equal(envelope(result.stderr).error.subtype, 'invalid_number');
});

test('report and Ads commands reject invalid date ranges before credentials are loaded', async () => {
  const report = await run([
    'report', 'run', '--type', 'GET_MERCHANT_LISTINGS_DATA', '--marketplace', 'US',
    '--start', 'not-a-date', '--end', '2026-07-02T00:00:00Z',
  ]);
  assert.equal(report.code, 2);
  assert.equal(envelope(report.stderr).error.subtype, 'invalid_start_time');

  const ads = await run([
    'ads', 'report-run', '--profile-id', '123', '--start', '2026-02-30', '--end', '2026-03-01',
  ]);
  assert.equal(ads.code, 2);
  assert.equal(envelope(ads.stderr).error.subtype, 'ads.invalid_date');
});

test('listing get and sku reject unsupported includedData locally', async () => {
  const catalog = await run([
    'listing', 'get', '--marketplace', 'US', '--asin', 'B000000000', '--include', 'notADataSet',
  ]);
  assert.equal(catalog.code, 2);
  assert.equal(envelope(catalog.stderr).error.subtype, 'invalid_included_data');

  const ownListing = await run([
    'listing', 'sku', '--marketplace', 'US', '--sku', 'SKU-1', '--include', 'notADataSet',
  ]);
  assert.equal(ownListing.code, 2);
  assert.equal(envelope(ownListing.stderr).error.subtype, 'invalid_included_data');
});

test('sensitive auth exchange is rejected outside a TTY', async () => {
  const result = await run(['ads', 'auth-exchange', '--code', 'one-time-code']);
  assert.equal(result.code, 10);
  assert.equal(envelope(result.stderr).error.subtype, 'sensitive_command_requires_tty');
});

test('Feed dry-run is local and returns a preview token without credentials', async () => {
  const stateDir = `tests/.validation-state-${process.pid}`;
  const previous = process.env.AMZ_CLI_STATE_DIR;
  process.env.AMZ_CLI_STATE_DIR = stateDir;
  try {
    const result = await execFileAsync(process.execPath, [
      'dist/cli.js', 'feed', 'submit', '--marketplace', 'US',
      '--type', 'POST_FLAT_FILE_INVLOADER_DATA', '--file', 'examples/sandbox-feed.tsv', '--dry-run',
    ], {
      cwd: process.cwd(),
      env: {
        AMZ_CLI_SKIP_DOTENV: 'true',
        AMZ_CLI_STATE_DIR: stateDir,
      },
      windowsHide: true,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.meta.dry_run, true);
    assert.match(output.meta.preview_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal('uploadedFeedDocumentId' in output.data, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AMZ_CLI_STATE_DIR;
    else process.env.AMZ_CLI_STATE_DIR = previous;
  }
});

test('keyword campaign dry-run is local and returns a plan-bound preview token without credentials', async () => {
  const stateDir = `tests/.keyword-campaign-preview-state-${process.pid}`;
  try {
    const result = await execFileAsync(process.execPath, [
      'dist/cli.js', 'ads', 'keyword-campaign-launch',
      '--plan', 'examples/keyword-campaign-plan.example.json', '--dry-run',
    ], {
      cwd: process.cwd(),
      env: {
        AMZ_CLI_SKIP_DOTENV: 'true',
        AMZ_CLI_STATE_DIR: stateDir,
      },
      windowsHide: true,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.meta.dry_run, true);
    assert.match(output.meta.preview_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(output.data.campaign.campaigns[0].state, 'PAUSED');
    assert.equal(output.data.keywordCount, 2);
    assert.equal(result.stderr.includes('Amazon'), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
