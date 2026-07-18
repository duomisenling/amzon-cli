// ads campaign-budget —— 调整广告活动日预算【写操作,reversible】
//
// 依据(2026-07-14 官方 Postman 集合核实 + 真实账号实测):
//   PUT  /sp/campaigns  body {campaigns:[{campaignId, budget:{budgetType:"DAILY", budget}}]}
//   查当前预算:POST /sp/campaigns/list body {campaignIdFilter:{include:[id]}}
//   (campaignIdFilter 已实测:HTTP 200 精确命中并返回当前 budget)
//
// dry-run 展示"当前预算 → 新预算"对照(规格 §8.2 rule 3 的 diff 精神)。

import { AmzError } from '../../internal/errs/errors.js';
import { AdsClient, ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import {
  ADS_REGION_FLAG,
  adsRegion,
  assertAdsWriteAccepted,
  assertChangeNeeded,
  requireCampaignId,
  requirePositiveAmount,
  requireProfileId,
  verifyAfterWrite,
} from './common.js';

/** 查单个 campaign 的当前信息(名称/预算/状态)。 */
export async function fetchCampaign(
  client: AdsClient,
  profileId: string,
  campaignId: string,
  region?: 'na' | 'eu' | 'fe',
): Promise<Record<string, unknown> | undefined> {
  const resp = (await client.request('POST', '/sp/campaigns/list', {
    profileId,
    region,
    contentType: ADS_CONTENT_TYPES.spCampaign,
    retry5xx: true,
    body: { campaignIdFilter: { include: [campaignId] } },
  })) as { campaigns?: Array<Record<string, unknown>> } | null;
  return resp?.campaigns?.[0];
}

function campaignStateFromContext(ctx: ToolContext): Record<string, unknown> | undefined {
  const value = ctx.confirmationState;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export const adsCampaignBudget: ToolDefinition = {
  service: 'ads',
  command: 'campaign-budget',
  description: '调整广告活动日预算。写操作:--dry-run 显示当前→新预算对照,人工终端 --confirm 执行',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'campaign-id', desc: '广告活动 ID(必填,ads campaigns 可查)', required: true },
    { name: 'daily-budget', desc: '新的日预算,数字,账户币种(必填)', required: true },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    requireCampaignId(flags);
    requirePositiveAmount(flags, 'dailyBudget', '--daily-budget');
  },
  describe: (flags) =>
    `将广告账户 ${strFlag(flags, 'profileId')} 的广告活动 ${strFlag(flags, 'campaignId')} ` +
    `日预算改为 ${strFlag(flags, 'dailyBudget')}(账户币种)`,
  confirmationStateSnapshot: async (ctx) => {
    const current = await fetchCampaign(
      ctx.adsClient,
      requireProfileId(ctx.flags),
      requireCampaignId(ctx.flags),
      adsRegion(ctx.flags),
    );
    if (!current) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.campaign_not_found',
        param: '--campaign-id',
        hintAgent: 'fix_param',
        hintHuman: '没有找到广告活动，请用 ads campaigns 核对账户和 campaign-id。',
        message: 'campaign not found while capturing confirmation state',
      });
    }
    return current;
  },
  dryRun: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const campaignId = requireCampaignId(ctx.flags);
    const newBudget = requirePositiveAmount(ctx.flags, 'dailyBudget', '--daily-budget');

    ctx.progress('· 已查询当前预算做对照...');
    const current = campaignStateFromContext(ctx);
    if (!current) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.campaign_not_found',
        param: '--campaign-id',
        hintAgent: 'fix_param',
        hintHuman: `在账户 ${profileId} 里没有找到广告活动 ${campaignId},请用 ads campaigns 核对。`,
        message: `campaign ${campaignId} not found in profile ${profileId}`,
      });
    }
    const currentBudget = (current['budget'] as Record<string, unknown> | undefined)?.['budget'];
    assertChangeNeeded(Number(currentBudget), newBudget, '日预算');
    return {
      dry_run_note: '请人工核对以下预算改动;确认后凭本次预览令牌执行正式写入。',
      campaign: { id: campaignId, name: current['name'], state: current['state'] },
      change: {
        current_daily_budget: currentBudget,
        new_daily_budget: newBudget,
      },
      endpoint: 'PUT /sp/campaigns',
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const campaignId = requireCampaignId(ctx.flags);
    const newBudget = requirePositiveAmount(ctx.flags, 'dailyBudget', '--daily-budget');
    ctx.progress('· 正在修改日预算...');
    const resp = await ctx.adsClient.request('PUT', '/sp/campaigns', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spCampaign,
      body: {
        campaigns: [{ campaignId, budget: { budgetType: 'DAILY', budget: newBudget } }],
      },
      extraHeaders: { Prefer: 'return=representation' },
    });
    assertAdsWriteAccepted(resp, 'campaigns', '预算修改');
    const verification = await verifyAfterWrite(
      () => fetchCampaign(ctx.adsClient, profileId, campaignId, adsRegion(ctx.flags)),
      (record) => Number((record['budget'] as Record<string, unknown> | undefined)?.['budget']) === newBudget,
      '即时回读未确认新预算。不要自动重试写入，请稍后只读查询或到广告后台核对。',
    );
    return { result: resp, ...verification };
  },
};
