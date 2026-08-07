// shortcuts 共用的小工具(参照 lark-cli shortcuts/common 的角色)

import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { AmzError } from '../internal/errs/errors.js';
import { amazonFetch, type EgressChannel } from '../internal/net/egress.js';
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

export function isIso8601(value: string): boolean {
  // 时区偏移可省略:"2026-08-06T00:00:00" 是合法 ISO 8601 本地时间,
  // 各命令发给 API 前会用 expandDateOnlyIso 补全成带偏移的完整时间戳。
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) ||
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

/** 判断是否纯日期(YYYY-MM-DD,无时间部分)。 */
export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 校验 IANA 时区名(如 America/Los_Angeles / UTC);非法抛类型化 invalid_param。 */
export function validateTimeZoneFlag(flags: Record<string, unknown>, key = 'timezone'): void {
  const tz = strFlag(flags, key);
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_timezone',
      param: '--timezone',
      hintAgent: 'fix_param',
      hintHuman: `不认识的时区 "${tz}"。请用 IANA 时区名,如 America/Los_Angeles、Asia/Shanghai、UTC。`,
      message: `invalid IANA time zone: ${tz}`,
    });
  }
}

/** 取某 UTC 时刻在指定时区的偏移(±HH:MM 形式)。 */
function utcOffsetAt(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(instantMs);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // 形如 "GMT-07:00" / "GMT+05:30" / "GMT"(=UTC)
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return '+00:00';
  const sign = m[1]!.startsWith('-') ? '-' : '+';
  const hh = String(Math.abs(Number(m[1]))).padStart(2, '0');
  return `${sign}${hh}:${m[2] ?? '00'}`;
}

/**
 * 把纯日期(YYYY-MM-DD)补全成带时区偏移的完整 ISO 时间戳:
 * 起始=当日 00:00:00,截止=当日 23:59:59,偏移按 timeZone(默认 UTC)计算。
 * 非纯日期的输入原样返回(已是完整时间戳,不动)。
 * 背景:部分接口(如 Sales getOrderMetrics)要求完整 ISO 时间,纯日期会被 API 拒;
 * 本地补全比报错更友好,且能按用户选定时区切日。
 */
export function expandDateOnlyIso(value: string, endOfDay: boolean, timeZone = 'UTC'): string {
  if (isDateOnly(value)) {
    const time = endOfDay ? '23:59:59' : '00:00:00';
    return attachOffset(value, time, timeZone);
  }
  // "有时分秒但没时区"(如 2026-08-06T00:00:00)是最常见的手误:API 必拒,
  // 语义又无歧义(按所选时区理解),同样自动补上时区偏移而不是让上游报 400。
  const noOffset = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/.exec(value);
  if (noOffset) {
    const time = noOffset[2]!.length === 5 ? `${noOffset[2]}:00` : noOffset[2]!;
    return attachOffset(noOffset[1]!, time, timeZone);
  }
  return value; // 已带 Z/偏移或其他格式,原样交给校验与上游
}

/** 把"日期 + 时分秒"拼成带该时区偏移的完整 ISO 时间戳。 */
function attachOffset(date: string, time: string, timeZone: string): string {
  if (timeZone === 'UTC') return `${date}T${time}Z`;
  // 两步逼近:先按 UTC 同刻猜偏移,再用猜出的本地时刻重取一次(覆盖夏令时切换日)
  const guess = utcOffsetAt(Date.parse(`${date}T${time}Z`), timeZone);
  const offset = utcOffsetAt(Date.parse(`${date}T${time}${guess}`), timeZone);
  return `${date}T${time}${offset}`;
}

/** 自动翻页命令的页数熔断上限(防上游 nextToken 异常导致的无限翻页)。 */
export const MAX_AUTO_PAGES = 100;

/** 翻页熔断:页数超过 MAX_AUTO_PAGES 抛类型化上游错误(调用方传各自的 subtype 与描述)。 */
export function assertPageWithinLimit(page: number, subtype: string, what: string): void {
  if (page <= MAX_AUTO_PAGES) return;
  throw new AmzError({
    type: 'upstream_error',
    subtype,
    hintAgent: 'report_to_human',
    hintHuman:
      `${what}翻页超过 ${MAX_AUTO_PAGES} 页仍未结束,已熔断中止(疑似接口分页异常或数据量异常)。` +
      '请稍后重试;若反复出现请联系管理员。',
    message: `pagination exceeded ${MAX_AUTO_PAGES} pages while fetching ${what}`,
  });
}

/**
 * --out 写文件的统一处理:给了路径就写完整 JSON 到文件、返回摘要,否则原样返回。
 * summary 是文件模式下 stdout 摘要要带的字段(如 moduleCount/状态);
 * 不给时回退取 data.count(多数列表型命令的惯例字段),没有就只报 savedTo。
 * (aplus 与 ads/product-ads 曾各有一份逐字重复的私有副本,已统一收拢到这里。)
 */
export function deliver(
  out: string | undefined,
  data: Record<string, unknown>,
  summary?: Record<string, unknown>,
): Record<string, unknown> {
  if (out) {
    writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8');
    const fallback =
      typeof data['count'] === 'number' ? { count: data['count'] } : {};
    return { savedTo: out, ...(summary ?? fallback) };
  }
  return data;
}

/**
 * 下载亚马逊签发的文档(预签名 URL,故意不走带认证头的 client),
 * 校验 HTTP 状态并按需 GZIP 解压,返回原始 Buffer。
 * report / feed / ads 报表三处共用;文本解码方式由调用方决定。
 */
export async function fetchDocumentBuffer(
  url: string,
  opts: { gzip?: boolean; what: string; subtype: string; channel?: EgressChannel },
): Promise<Buffer> {
  // 预签名地址虽然不带认证头,但主机同样是亚马逊侧的(amazonaws.com),
  // 所以也要按账号配置的代理发出,与其他请求保持一致的出口。
  const resp = await amazonFetch(url, { signal: AbortSignal.timeout(120_000) }, opts.channel ?? 'sp');
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
