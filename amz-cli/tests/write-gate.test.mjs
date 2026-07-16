import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
    return {
      code: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function parseErrorEnvelope(stderr) {
  const start = stderr.indexOf('{');
  assert.notEqual(start, -1, `stderr did not contain an error envelope: ${stderr}`);
  return JSON.parse(stderr.slice(start));
}

test('irreversible writes require --dry-run or --confirm', async () => {
  const result = await run([
    'feed',
    'submit',
    '--marketplace',
    'US',
    '--type',
    'POST_FLAT_FILE_INVLOADER_DATA',
    '--file',
    'examples/sandbox-feed.tsv',
  ]);

  assert.equal(result.code, 10);
  const envelope = parseErrorEnvelope(result.stderr);
  assert.equal(envelope.error.type, 'confirmation_required');
  assert.equal(envelope.error.subtype, 'preview_first');
  assert.equal(result.stdout, '');
});

test('reversible writes retain the same gate', async () => {
  const result = await run([
    'ads',
    'campaign-state',
    '--profile-id',
    '123',
    '--campaign-id',
    '456',
    '--state',
    'PAUSED',
  ]);

  assert.equal(result.code, 10);
  const envelope = parseErrorEnvelope(result.stderr);
  assert.equal(envelope.error.subtype, 'preview_first');
  assert.equal(result.stdout, '');
});

test('--confirm requires a token produced by --dry-run', async () => {
  const result = await run([
    'feed',
    'submit',
    '--marketplace',
    'US',
    '--type',
    'POST_FLAT_FILE_INVLOADER_DATA',
    '--file',
    'examples/sandbox-feed.tsv',
    '--confirm',
  ]);

  assert.equal(result.code, 10);
  const envelope = parseErrorEnvelope(result.stderr);
  assert.equal(envelope.error.subtype, 'preview_token_required');
  assert.equal(result.stdout, '');
});

test('automation cannot consume a supplied preview token', async () => {
  const result = await run([
    'feed',
    'submit',
    '--marketplace',
    'US',
    '--type',
    'POST_FLAT_FILE_INVLOADER_DATA',
    '--file',
    'examples/sandbox-feed.tsv',
    '--confirm',
    '--preview-token',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ]);

  assert.equal(result.code, 10);
  const envelope = parseErrorEnvelope(result.stderr);
  assert.equal(envelope.error.subtype, 'interactive_terminal_required');
  assert.equal(result.stdout, '');
});

test('keyword campaign CLI confirmation still requires an interactive human terminal', async () => {
  const result = await run([
    'ads',
    'keyword-campaign-launch',
    '--plan',
    'examples/keyword-campaign-plan.example.json',
    '--confirm',
    '--preview-token',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ]);

  assert.equal(result.code, 10);
  const envelope = parseErrorEnvelope(result.stderr);
  assert.equal(envelope.error.subtype, 'interactive_terminal_required');
  assert.equal(result.stdout, '');
});
