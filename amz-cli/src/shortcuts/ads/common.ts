// ads 域共用校验(此前散落在各命令文件里的重复实现,统一收编于此)

import { AmzError } from '../../internal/errs/errors.js';
import { strFlag } from '../common.js';

/** --profile-id 必须为纯数字;返回校验后的值。 */
export function requireProfileId(flags: Record<string, unknown>): string {
  const profileId = strFlag(flags, 'profileId') ?? '';
  if (!/^\d+$/.test(profileId)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_profile_id',
      param: '--profile-id',
      hintAgent: 'fix_param',
      hintHuman: `--profile-id 应为纯数字(收到 "${profileId}")。先用 ads profiles 查询。`,
      message: `invalid profileId: ${profileId}`,
    });
  }
  return profileId;
}

/** --campaign-id 必须为纯数字;返回校验后的值。 */
export function requireCampaignId(flags: Record<string, unknown>): string {
  const campaignId = strFlag(flags, 'campaignId') ?? '';
  if (!/^\d+$/.test(campaignId)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_campaign_id',
      param: '--campaign-id',
      hintAgent: 'fix_param',
      hintHuman: '--campaign-id 应为纯数字(用 ads campaigns 查询)。',
      message: `invalid campaignId: ${campaignId}`,
    });
  }
  return campaignId;
}

/** 日期 flag 必须为 YYYY-MM-DD;返回校验后的值。 */
export function requireDate(
  flags: Record<string, unknown>,
  key: string,
  flagName: string,
): string {
  const v = strFlag(flags, key);
  const parsed = v ? Date.parse(`${v}T00:00:00.000Z`) : Number.NaN;
  const valid =
    Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v)) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === v;
  if (!valid) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_date',
      param: flagName,
      hintAgent: 'fix_param',
      hintHuman: `${flagName} 必须是 YYYY-MM-DD 格式(收到 "${v ?? ''}")。`,
      message: `${flagName} must be YYYY-MM-DD, got: ${v ?? '(empty)'}`,
    });
  }
  return v;
}

/** 校验广告日期范围；同一天的日报允许 start=end。 */
export function validateDateRange(flags: Record<string, unknown>): void {
  const start = requireDate(flags, 'start', '--start');
  const end = strFlag(flags, 'end');
  if (!end) return;
  const validEnd = requireDate(flags, 'end', '--end');
  if (start > validEnd) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_date_range',
      param: '--start',
      hintAgent: 'fix_param',
      hintHuman: '--start 不能晚于 --end。',
      message: '--start must not be after --end',
    });
  }
}

/** 金额类 flag(预算/竞价)必须为正数;返回数值。 */
export function requirePositiveAmount(
  flags: Record<string, unknown>,
  key: string,
  flagName: string,
): number {
  const n = Number(strFlag(flags, key));
  if (!Number.isFinite(n) || n <= 0) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_amount',
      param: flagName,
      hintAgent: 'fix_param',
      hintHuman: `${flagName} 必须是大于 0 的数字(单位:账户币种)。`,
      message: `${flagName} must be a positive number, got: ${strFlag(flags, key)}`,
    });
  }
  return n;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把门禁预读的远端状态(ctx.confirmationState)取成对象,非对象返回 undefined。 */
export function recordFromContext(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export interface AdsMultistatusGroup {
  /** 是否识别出了 success/error 结构;false 表示响应形状未知,交给写后回读判定。 */
  known: boolean;
  success: Array<Record<string, unknown>>;
  error: Array<Record<string, unknown>>;
}

/** 拆解 Ads v3 写响应(HTTP 207 multistatus)中单个分组的 success/error 数组。 */
export function adsResponseGroup(resp: unknown, group: string): AdsMultistatusGroup {
  const raw = isRecord(resp) ? resp[group] : undefined;
  if (Array.isArray(raw)) {
    return { known: true, success: raw.filter(isRecord), error: [] };
  }
  if (isRecord(raw) && (Array.isArray(raw['success']) || Array.isArray(raw['error']))) {
    return {
      known: true,
      success: Array.isArray(raw['success']) ? raw['success'].filter(isRecord) : [],
      error: Array.isArray(raw['error']) ? raw['error'].filter(isRecord) : [],
    };
  }
  return { known: false, success: [], error: [] };
}

/**
 * 校验 Ads 写响应的业务结果:HTTP 2xx/207 不代表写入成功,真正的结果在
 * success/error 数组里(2026-07-17 官方 Postman 集合核实)。error 命中或成功数
 * 不足即抛错;区分整批拒绝与部分成功。响应形状无法识别时不抛,留给写后回读。
 */
export function assertAdsWriteAccepted(
  resp: unknown,
  group: string,
  operation: string,
  expected = 1,
): AdsMultistatusGroup {
  const result = adsResponseGroup(resp, group);
  if (!result.known) return result;
  if (result.error.length === 0 && result.success.length === expected) return result;
  const rejectedAll = result.success.length === 0;
  throw new AmzError({
    type: 'upstream_error',
    subtype: rejectedAll ? 'ads.write_rejected' : 'ads.write_partial_failure',
    hintAgent: 'report_to_human',
    hintHuman: rejectedAll
      ? `Amazon 拒绝了本次${operation}(成功 0/${expected})。请根据错误详情修正后重新预览;不要自动重试。`
      : `本次${operation}只成功 ${result.success.length}/${expected},其余被 Amazon 拒绝。` +
        '请先核对已成功的部分,不要自动重试整批写入。',
    message:
      `ads ${operation} multistatus ${rejectedAll ? 'rejected' : 'partial failure'} ` +
      `(${result.success.length}/${expected} succeeded): ${JSON.stringify(result.error).slice(0, 2000)}`,
  });
}

/**
 * 预览阶段的 no-op 守卫:当前值已等于目标值时拒发确认令牌。
 * 这也堵住"请求值恰好等于现值→远端拒绝了 PUT 但回读仍匹配→误报 VERIFIED"的路径。
 * 调用方需先把两侧归一化成可 === 比较的值(数字用 Number)。
 */
export function assertChangeNeeded(current: unknown, next: unknown, what: string): void {
  if (current !== next) return;
  throw new AmzError({
    type: 'invalid_param',
    subtype: 'ads.no_change_needed',
    hintAgent: 'report_to_human',
    hintHuman:
      `当前${what}已等于目标值(${String(next)}),无需写入,本次不签发确认令牌。` +
      '若这是在复核先前结果不明的写入,这说明它已生效,不要再重试。',
    message: `no-op ${what} write rejected: current value already equals ${String(next)}`,
  });
}

export interface AdsWriteVerification {
  readback?: Record<string, unknown>;
  readbackError?: string;
  verificationStatus: 'VERIFIED' | 'PENDING_OR_MISMATCH';
  note?: string;
}

/** 写入后立即回读核对;回读失败只记录,不影响已完成的写入结果上报。 */
export async function verifyAfterWrite(
  fetchCurrent: () => Promise<Record<string, unknown> | undefined>,
  isVerified: (record: Record<string, unknown>) => boolean,
  mismatchNote: string,
): Promise<AdsWriteVerification> {
  let readback: Record<string, unknown> | undefined;
  let readbackError: string | undefined;
  try {
    readback = await fetchCurrent();
  } catch (error) {
    readbackError = error instanceof Error ? error.message : String(error);
  }
  const verificationStatus = readback && isVerified(readback) ? 'VERIFIED' : 'PENDING_OR_MISMATCH';
  return {
    ...(readback !== undefined ? { readback } : {}),
    ...(readbackError ? { readbackError } : {}),
    verificationStatus,
    ...(verificationStatus !== 'VERIFIED' ? { note: mismatchNote } : {}),
  };
}

/** 广告区域 flag:同一套广告凭证全区域通用,只需切端点(2026-07-15 官方核实)。 */
export const ADS_REGION_FLAG = {
  name: 'region',
  desc: '广告区域(可选,默认 .env 的 ADS_REGION):na | eu | fe。查询/操作 EU 的广告账户时带 --region eu',
  enum: ['na', 'eu', 'fe'],
};

/** 读取 --region(框架已按 enum 校验并规范化)。 */
export function adsRegion(flags: Record<string, unknown>): 'na' | 'eu' | 'fe' | undefined {
  return strFlag(flags, 'region') as 'na' | 'eu' | 'fe' | undefined;
}
