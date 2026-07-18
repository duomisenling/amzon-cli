import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AmzError } from '../errs/errors.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OMITTED_FLAG_KEYS = new Set(['dryRun', 'confirm', 'previewToken']);

interface PreviewRecord {
  version: 1;
  operation: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
}

export interface IssuedPreviewToken {
  token: string;
  expiresAt: string;
}

function stateDir(): string {
  const override = process.env['AMZ_CLI_STATE_DIR']?.trim();
  return override || join(homedir(), '.amz-cli', 'previews');
}

function tokenFile(token: string): string {
  const name = createHash('sha256').update(token).digest('hex');
  return join(stateDir(), `${name}.json`);
}

/**
 * 归一化后再序列化,保证键序/undefined 差异不影响比较。
 * 令牌指纹(本文件)与快照相等判断(tools/confirmation.ts)必须共用这一份实现:
 * 两者一旦分叉,"是否发令牌"和"令牌是否验过"会对同一份数据得出不同结论。
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

function fingerprint(
  operation: string,
  flags: Record<string, unknown>,
  confirmationSnapshot?: unknown,
): string {
  const businessFlags: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (!OMITTED_FLAG_KEYS.has(key) && value !== undefined) businessFlags[key] = value;
  }
  const payload = canonicalize({ operation, flags: businessFlags, confirmationSnapshot });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function confirmationError(
  subtype: string,
  hintHuman: string,
  message: string,
  param = '--preview-token',
): AmzError {
  return new AmzError({
    type: 'confirmation_required',
    subtype,
    param,
    hintAgent: 'needs_human_confirm',
    hintHuman,
    message,
  });
}

/**
 * 成功预览后签发本机一次性令牌。令牌本身只返回给调用者；磁盘文件名是令牌哈希，
 * 文件内容只保存操作指纹和有效期。
 */
export function issuePreviewToken(
  operation: string,
  flags: Record<string, unknown>,
  now = Date.now(),
  confirmationSnapshot?: unknown,
): IssuedPreviewToken {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
    const record: PreviewRecord = {
      version: 1,
      operation,
      fingerprint: fingerprint(operation, flags, confirmationSnapshot),
      createdAt: new Date(now).toISOString(),
      expiresAt,
    };
    try {
      writeFileSync(tokenFile(token), JSON.stringify(record), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return { token, expiresAt };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || attempt === 2) throw err;
    }
  }
  throw new Error('failed to allocate preview token');
}

/**
 * 校验令牌是否存在、未过期且与本次命令参数完全一致，然后原子消费。
 * 调用方必须先确认当前是人工 TTY，避免自动化流程消耗真人的令牌。
 */
function validatePreviewToken(
  operation: string,
  flags: Record<string, unknown>,
  token: string,
  now = Date.now(),
  confirmationSnapshot?: unknown,
): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw confirmationError(
      'preview_token_invalid',
      '预览令牌无效。请重新运行 --dry-run，并复制输出中的 preview_token。',
      'preview token has an invalid format',
    );
  }

  const path = tokenFile(token);
  let record: PreviewRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as PreviewRecord;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw confirmationError(
        'preview_token_invalid',
        '预览令牌不存在或已经使用过。请重新运行 --dry-run。',
        'preview token was not found or was already consumed',
      );
    }
    throw err;
  }

  const expiresAt = Date.parse(record.expiresAt);
  if (record.version !== 1 || !Number.isFinite(expiresAt)) {
    throw confirmationError(
      'preview_token_invalid',
      '预览令牌记录已损坏。请重新运行 --dry-run。',
      'preview token record is malformed',
    );
  }
  if (now >= expiresAt) {
    rmSync(path, { force: true });
    throw confirmationError(
      'preview_token_expired',
      '预览令牌已超过 15 分钟。请重新运行 --dry-run，确认最新预览后再执行。',
      'preview token has expired',
    );
  }

  const expected = fingerprint(operation, flags, confirmationSnapshot);
  if (record.operation !== operation || record.fingerprint !== expected) {
    throw confirmationError(
      'preview_token_mismatch',
      '当前命令或参数与预览时不一致。请用完全相同的业务参数执行，或重新运行 --dry-run。',
      'preview token does not match the operation and flags',
    );
  }

  return path;
}

/** 只校验不消费；用于在展示人工确认提示前尽早发现错误令牌。 */
export function verifyPreviewToken(
  operation: string,
  flags: Record<string, unknown>,
  token: string,
  now = Date.now(),
  confirmationSnapshot?: unknown,
): void {
  validatePreviewToken(operation, flags, token, now, confirmationSnapshot);
}

/** 校验并原子消费；必须在人工确认完成、执行输入已冻结之后调用。 */
export function verifyAndConsumePreviewToken(
  operation: string,
  flags: Record<string, unknown>,
  token: string,
  now = Date.now(),
  confirmationSnapshot?: unknown,
): void {
  const path = validatePreviewToken(operation, flags, token, now, confirmationSnapshot);

  // rename 是同一目录内的原子操作；并发确认时只有一个进程能成功消费。
  const consumedPath = `${path}.consumed-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, consumedPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw confirmationError(
        'preview_token_invalid',
        '预览令牌已经被使用。请重新运行 --dry-run。',
        'preview token was consumed concurrently',
      );
    }
    throw err;
  }
  unlinkSync(consumedPath);
}
