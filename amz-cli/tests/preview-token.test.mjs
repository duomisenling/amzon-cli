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

// ───────────────────────────────── 运行时快照(确认令牌绑定的环境)

test('沙盒开关进入运行时快照:预览后切换沙盒状态,快照必须不同', async () => {
  // 这条拦的是"沙盒里 --dry-run 预览、关掉沙盒后 --confirm 打到生产":
  // 若快照不含 SP_API_SANDBOX,这两个环境在校验眼里完全相同。
  const { runtimeConfirmationSnapshot } = await import(
    '../dist/internal/confirmation/runtime-snapshot.js'
  );
  const saved = process.env.SP_API_SANDBOX;
  try {
    process.env.SP_API_SANDBOX = 'true';
    const inSandbox = runtimeConfirmationSnapshot();
    delete process.env.SP_API_SANDBOX;
    const inProd = runtimeConfirmationSnapshot();
    assert.notDeepEqual(inSandbox, inProd, '沙盒开关切换后快照竟然相同 —— 令牌会被跨环境使用');
    assert.equal(inSandbox.SP_API_SANDBOX, 'true');
    assert.equal(inProd.SP_API_SANDBOX, '');
  } finally {
    if (saved === undefined) delete process.env.SP_API_SANDBOX;
    else process.env.SP_API_SANDBOX = saved;
  }
});
