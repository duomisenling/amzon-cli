// shortcuts 共用的小工具(参照 lark-cli shortcuts/common 的角色)

import { gunzipSync } from 'node:zlib';
import { AmzError } from '../internal/errs/errors.js';
import {
  MARKETPLACES,
  marketplaceByCountry,
  marketplaceById,
  type MarketplaceInfo,
  type Region,
} from '../internal/client/regions.js';

/**
 * 解析 --marketplace 的值:接受国家码(US/DE,大小写不限)或原始 marketplaceId。
 * 解析失败抛类型化 invalid_param。
 */
export function resolveMarketplace(value: unknown): MarketplaceInfo {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'missing_marketplace',
      param: '--marketplace',
      hintAgent: 'fix_param',
      hintHuman: `请用 --marketplace 指定市场,例如 --marketplace US。可选:${MARKETPLACES.map((m) => m.country).join(' / ')}`,
      message: '--marketplace is required',
    });
  }
  const found = marketplaceByCountry(raw) ?? marketplaceById(raw);
  if (!found) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'unknown_marketplace',
      param: '--marketplace',
      hintAgent: 'fix_param',
      hintHuman: `不认识的市场 "${raw}"。可选:${MARKETPLACES.map((m) => m.country).join(' / ')},或直接传 marketplaceId。`,
      message: `unknown marketplace: ${raw}`,
    });
  }
  return found;
}

/** 读取字符串 flag(commander 把 kebab-case 转成 camelCase 后的键)。 */
export function strFlag(flags: Record<string, unknown>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** 校验可选数字 flag；未提供时跳过。返回已校验数值或 undefined。 */
export function validateNumberFlag(
  flags: Record<string, unknown>,
  key: string,
  flagName: string,
  opts: { min: number; max: number; integer?: boolean },
): number | undefined {
  const raw = strFlag(flags, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  const valid =
    Number.isFinite(value) &&
    value >= opts.min &&
    value <= opts.max &&
    (!opts.integer || Number.isInteger(value));
  if (!valid) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_number',
      param: flagName,
      hintAgent: 'fix_param',
      hintHuman:
        `${flagName} 必须是 ${opts.min} 到 ${opts.max} 之间的` +
        `${opts.integer ? '整数' : '有限数字'}。`,
      message: `${flagName} must be ${opts.integer ? 'an integer' : 'a finite number'} in [${opts.min},${opts.max}], got: ${raw}`,
    });
  }
  return value;
}

/** 跟进类命令(按 ID 查订单/报告/feed)的可选市场 flag:用于路由到正确区域。 */
export const OPTIONAL_MARKETPLACE_FLAG = {
  name: 'marketplace',
  desc: '市场,国家码(可选,默认用 SP_API_REGION 区域;查询 EU 的数据时带上,如 DE)',
};

/** 解析可选的 --marketplace 为区域;未提供时返回 undefined(用默认区域)。 */
export function optionalRegion(flags: Record<string, unknown>): Region | undefined {
  const v = strFlag(flags, 'marketplace');
  return v ? resolveMarketplace(v).region : undefined;
}

/** N 天前的 ISO 8601 时间戳(整秒,无毫秒——部分亚马逊接口对格式敏感)。 */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

/** 校验可选 ISO 8601 起止时间，并确保开始早于结束。 */
export function validateIsoTimeRange(
  flags: Record<string, unknown>,
  startKey = 'start',
  endKey = 'end',
): void {
  const start = strFlag(flags, startKey);
  const end = strFlag(flags, endKey);
  if (start && !isIso8601(start)) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'invalid_start_time', param: '--start', hintAgent: 'fix_param',
      hintHuman: '--start 必须是合法的 ISO 8601 时间。', message: `invalid --start: ${start}`,
    });
  }
  if (end && !isIso8601(end)) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'invalid_end_time', param: '--end', hintAgent: 'fix_param',
      hintHuman: '--end 必须是合法的 ISO 8601 时间。', message: `invalid --end: ${end}`,
    });
  }
  if (start && end && Date.parse(start) >= Date.parse(end)) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'invalid_time_range', param: '--start', hintAgent: 'fix_param',
      hintHuman: '--start 必须早于 --end。', message: '--start must be before --end',
    });
  }
}

function isIso8601(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() + 1 === month &&
    calendarDate.getUTCDate() === day
  );
}

/**
 * 下载亚马逊签发的文档(预签名 URL,故意不走带认证头的 client),
 * 校验 HTTP 状态并按需 GZIP 解压,返回原始 Buffer。
 * report / feed / ads 报表三处共用;文本解码方式由调用方决定。
 */
export async function fetchDocumentBuffer(
  url: string,
  opts: { gzip?: boolean; what: string; subtype: string },
): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: opts.subtype,
      hintAgent: 'backoff_and_retry',
      hintHuman: `${opts.what}下载失败(下载地址有效期很短,可能已过期),请重新执行命令。`,
      message: `${opts.what} download failed: HTTP ${resp.status}`,
      status: resp.status,
      retryable: true,
    });
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  // Node fetch 可能按 Content-Encoding 自动解压；只有仍带 gzip magic bytes 时再解压。
  const hasGzipMagic = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return opts.gzip && hasGzipMagic ? gunzipSync(buf) : buf;
}
