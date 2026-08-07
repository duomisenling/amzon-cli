import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ───────────────────────────────── 目录清扫(过期令牌不再只增不减)

test('签发新令牌时顺手清扫已过期的令牌文件', () => {
  // 旧令牌 15 分钟后过期;正常流程它若不再被校验,文件会一直留在目录里
  issuePreviewToken('listing update', { sku: 'SKU-OLD' }, 1_000);
  assert.equal(readdirSync(stateDir).filter((n) => n.endsWith('.json')).length, 1);

  // 16 分钟后签发另一个令牌:过期文件被清扫,目录里只剩新令牌
  const later = 1_000 + 16 * 60 * 1000;
  const fresh = issuePreviewToken('listing update', { sku: 'SKU-NEW' }, later);
  assert.equal(readdirSync(stateDir).filter((n) => n.endsWith('.json')).length, 1);

  // 新令牌不受清扫影响,仍可正常消费
  verifyAndConsumePreviewToken('listing update', { sku: 'SKU-NEW' }, fresh.token, later + 1);
});

test('清扫不会误删未过期令牌', () => {
  const first = issuePreviewToken('listing update', { sku: 'SKU-1' }, 1_000);
  issuePreviewToken('listing update', { sku: 'SKU-2' }, 2_000);
  assert.equal(readdirSync(stateDir).filter((n) => n.endsWith('.json')).length, 2);
  verifyAndConsumePreviewToken('listing update', { sku: 'SKU-1' }, first.token, 3_000);
});

test('.consumed-* 残留文件(unlink 失败留下的)在下次签发时被清扫', () => {
  // 模拟 verifyAndConsume 里 rename 成功但 unlinkSync 失败留下的残留
  writeFileSync(join(stateDir, 'deadbeef.json.consumed-123-abcd'), '{}', 'utf8');
  issuePreviewToken('listing update', { sku: 'SKU-1' }, 1_000);
  assert.equal(readdirSync(stateDir).filter((n) => n.includes('.consumed-')).length, 0);
});

test('目录里的垃圾文件不会让签发失败', () => {
  // 内容读不出 expiresAt 的 .json:按 mtime 兜底判断(刚写的不算过期),清扫全程不抛错
  writeFileSync(join(stateDir, 'not-a-token.json'), 'not json at all', 'utf8');
  const issued = issuePreviewToken('listing update', { sku: 'SKU-1' }, 1_000);
  verifyAndConsumePreviewToken('listing update', { sku: 'SKU-1' }, issued.token, 2_000);
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
