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
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
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
