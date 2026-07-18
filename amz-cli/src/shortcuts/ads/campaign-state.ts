// ads campaign-state —— 启用/暂停广告活动【写操作,reversible】
//
// 依据(2026-07-14 官方 Postman 集合逐字核实):
//   PUT /sp/campaigns
//   Headers: ClientId + Bearer + Scope + Prefer: return=representation
//            + Accept/Content-Type: application/vnd.spCampaign.v3+json
//   Body: {campaigns:[{campaignId, state}]}(官方示例即改 state 用法)
//
// 只支持 ENABLED(启用,开始花钱)/ PAUSED(暂停,停止花钱)——两者互相可逆。
// 归档(ARCHIVED)不可恢复,按规格 §7.3 精神本期不开放。

import { AdsClient, ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import {
  ADS_REGION_FLAG,
  adsRegion,
  assertAdsWriteAccepted,
  assertChangeNeeded,
  requireCampaignId,
  requireProfileId,
  verifyAfterWrite,
} from './common.js';
import { fetchCampaign } from './campaign-budget.js';

/** 修改 campaign 状态(campaign-create 的"创建后追问启用"也复用这里)。 */
export async function setCampaignState(
  client: AdsClient,
  profileId: string,
  campaignId: string,
  state: 'ENABLED' | 'PAUSED',
  region?: 'na' | 'eu' | 'fe',
): Promise<unknown> {
  return client.request('PUT', '/sp/campaigns', {
    profileId,
    region,
    contentType: ADS_CONTENT_TYPES.spCampaign,
    body: { campaigns: [{ campaignId, state }] },
    extraHeaders: { Prefer: 'return=representation' },
  });
}

// state 的枚举校验与规范化由框架按 Flag.enum 统一完成,这里读到的值一定合法
function stateOf(flags: Record<string, unknown>): 'ENABLED' | 'PAUSED' {
  return strFlag(flags, 'state') as 'ENABLED' | 'PAUSED';
}

export const adsCampaignState: ToolDefinition = {
  service: 'ads',
  command: 'campaign-state',
  description: '启用或暂停广告活动。写操作:--dry-run 预览 → 人工终端 --confirm 执行',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'campaign-id', desc: '广告活动 ID(必填,ads campaigns 可查)', required: true },
    {
      name: 'state',
      desc: '目标状态(必填):ENABLED 启用(开始投放花钱)| PAUSED 暂停(停止花钱)',
      required: true,
      enum: ['ENABLED', 'PAUSED'],
    },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    requireCampaignId(flags);
  },
  describe: (flags) =>
    `将广告账户 ${strFlag(flags, 'profileId')} 的广告活动 ${strFlag(flags, 'campaignId')} ` +
    (stateOf(flags) === 'ENABLED'
      ? '切换为【启用】——立即开始投放并产生广告花费'
      : '切换为【暂停】——停止投放,不再花钱'),
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
        hintHuman: '没有找到广告活动，请核对 profile-id、region 和 campaign-id。',
        message: `campaign ${requireCampaignId(ctx.flags)} not found`,
      });
    }
    return current;
  },
  dryRun: async (ctx) => {
    const state = stateOf(ctx.flags);
    const current = ctx.confirmationState && typeof ctx.confirmationState === 'object'
      ? ctx.confirmationState as Record<string, unknown>
      : undefined;
    if (current) assertChangeNeeded(current['state'], state, '广告活动状态');
    return {
      dry_run_note: '以下为将提交的状态修改(客户端预览)。请人工核对;确认后凭本次预览令牌执行正式写入。',
      campaign: current
        ? { id: current['campaignId'], name: current['name'], currentState: current['state'] }
        : undefined,
      endpoint: 'PUT /sp/campaigns',
      payload: { campaigns: [{ campaignId: strFlag(ctx.flags, 'campaignId'), state }] },
      effect: state === 'ENABLED' ? '⚠️ 启用后立即开始投放花钱' : '暂停后停止花钱,随时可再启用',
    };
  },
  execute: async (ctx) => {
    const state = stateOf(ctx.flags);
    ctx.progress(`· 正在${state === 'ENABLED' ? '启用' : '暂停'}广告活动...`);
    const resp = await setCampaignState(
      ctx.adsClient,
      strFlag(ctx.flags, 'profileId')!,
      strFlag(ctx.flags, 'campaignId')!,
      state,
      adsRegion(ctx.flags),
    );
    assertAdsWriteAccepted(resp, 'campaigns', '状态修改');
    const verification = await verifyAfterWrite(
      () =>
        fetchCampaign(
          ctx.adsClient,
          strFlag(ctx.flags, 'profileId')!,
          strFlag(ctx.flags, 'campaignId')!,
          adsRegion(ctx.flags),
        ),
      (record) => record['state'] === state,
      '即时回读未确认目标状态。不要自动重试写入，请稍后只读查询或到广告后台核对。',
    );
    return { result: resp, ...verification };
  },
};
