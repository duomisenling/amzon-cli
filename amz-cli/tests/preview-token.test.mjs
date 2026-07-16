import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import {
  issuePreviewToken,
  verifyAndConsumePreviewToken,
} from '../dist/internal/confirmation/preview-token.js';

const stateDir = `tests/.preview-token-state-${process.pid}`;

beforeEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  process.env.AMZ_CLI_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.AMZ_CLI_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

test('a matching token can be consumed exactly once', () => {
  const flags = { marketplace: 'US', sku: 'SKU-1', confirm: true };
  const issued = issuePreviewToken('listing update', { ...flags, dryRun: true }, 1_000);

  verifyAndConsumePreviewToken(
    'listing update',
    { ...flags, previewToken: issued.token },
    issued.token,
    2_000,
  );

  assert.throws(
    () => verifyAndConsumePreviewToken('listing update', flags, issued.token, 2_001),
    (error) => error?.subtype === 'preview_token_invalid',
  );
});

test('changing a business parameter rejects but does not consume the token', () => {
  const previewFlags = { marketplace: 'US', dailyBudget: '10', dryRun: true };
  const issued = issuePreviewToken('ads campaign-budget', previewFlags, 1_000);

  assert.throws(
    () =>
      verifyAndConsumePreviewToken(
        'ads campaign-budget',
        { marketplace: 'US', dailyBudget: '20', confirm: true },
        issued.token,
        2_000,
      ),
    (error) => error?.subtype === 'preview_token_mismatch',
  );

  verifyAndConsumePreviewToken(
    'ads campaign-budget',
    { marketplace: 'US', dailyBudget: '10', confirm: true },
    issued.token,
    2_001,
  );
});

test('an expired token is rejected', () => {
  const flags = { marketplace: 'US', file: 'inventory.tsv' };
  const issued = issuePreviewToken('feed submit', flags, 1_000);

  assert.throws(
    () =>
      verifyAndConsumePreviewToken(
        'feed submit',
        flags,
        issued.token,
        1_000 + 16 * 60 * 1000,
      ),
    (error) => error?.subtype === 'preview_token_expired',
  );
});

test('changing referenced file content rejects the token', () => {
  const flags = { marketplace: 'US', file: 'inventory.tsv' };
  const issued = issuePreviewToken(
    'feed submit',
    flags,
    1_000,
    { feedContentSha256: 'before' },
  );

  assert.throws(
    () =>
      verifyAndConsumePreviewToken(
        'feed submit',
        flags,
        issued.token,
        2_000,
        { feedContentSha256: 'after' },
      ),
    (error) => error?.subtype === 'preview_token_mismatch',
  );

  verifyAndConsumePreviewToken(
    'feed submit',
    flags,
    issued.token,
    2_001,
    { feedContentSha256: 'before' },
  );
});
