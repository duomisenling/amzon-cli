// ads campaign-create —— 创建 SP(商品推广)广告活动【写操作,reversible】
//
// 依据(2026-07-13 官方 Postman 集合逐字核实):
//   POST /sp/campaigns
//   Headers: ClientId + Bearer + Scope(profileId)
//            + Prefer: return=representation(让响应带回创建结果)
//            + Accept/Content-Type: application/vnd.spCampaign.v3+json
//   Body: {campaigns:[{name, targetingType: MANUAL|AUTO, state,
//          startDate, endDate?, budget:{budgetType:"DAILY", budget:<数字>}}]}
//
// 安全设计:
//   - mutation=reversible:campaign 创建后可暂停/归档,可回退
//   - 广告 API 没有服务端校验预览(不同于 Listing 的 VALIDATION_PREVIEW),
//     dry-run 为客户端预览:展示将提交的完整 payload,由人核对
//   - state 默认 PAUSED(暂停):即使 --confirm 创建成功,广告也不会立即
//     开始花钱;启用必须另走 campaign-state 的独立预览与确认
//   - 首次验证请在测试账户(ads test-account)里做,勿直接在真实账户测试

import { ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion, requireDate, requirePositiveAmount, requireProfileId, validateDateRange } from './common.js';

/** 从创建响应中尽力提取 campaignId(结构因响应版本而异,取不到不猜)。 */
function extractCampaignId(resp: unknown): string | undefined {
  const r = resp as Record<string, unknown> | null;
  const c = r?.['campaigns'] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  let v: unknown;
  if (Array.isArray(c)) {
    v = c[0]?.['campaignId'];
  } else if (c && typeof c === 'object') {
    const success = c['success'] as Array<Record<string, unknown>> | undefined;
    v = success?.[0]?.['campaignId'] ?? (success?.[0]?.['campaign'] as Record<string, unknown> | undefined)?.['campaignId'];
  }
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
}

/** 从 flags 组装官方 payload(dry-run 与 execute 用同一份,预览即所提交)。
 *  targetingType/state 的枚举校验与规范化由框架按 Flag.enum 完成。 */
function buildPayload(flags: Record<string, unknown>): Record<string, unknown> {
  const end = strFlag(flags, 'end');
  return {
    campaigns: [
      {
        name: strFlag(flags, 'name')!,
        targetingType: strFlag(flags, 'targetingType'),
        state: strFlag(flags, 'state') ?? 'PAUSED',
        startDate: requireDate(flags, 'start', '--start'),
        ...(end ? { endDate: requireDate(flags, 'end', '--end') } : {}),
        budget: { budgetType: 'DAILY', budget: requirePositiveAmount(flags, 'dailyBudget', '--daily-budget') },
      },
    ],
  };
}

export const adsCampaignCreate: ToolDefinition = {
  service: 'ads',
  command: 'campaign-create',
  description:
    '创建 SP 广告活动。写操作:先 --dry-run 预览 payload,人工确认后 --confirm 执行;默认创建为暂停状态(不花钱)',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    { name: 'name', desc: '广告活动名称(必填)', required: true },
    {
      name: 'targeting-type',
      desc: '投放方式(必填):MANUAL 手动 | AUTO 自动',
      required: true,
      enum: ['MANUAL', 'AUTO'],
    },
    { name: 'daily-budget', desc: '日预算,数字,账户币种(必填)', required: true },
    { name: 'start', desc: '开始日期 YYYY-MM-DD(必填)', required: true },
    { name: 'end', desc: '结束日期 YYYY-MM-DD(可选,不填为长期)' },
    {
      name: 'state',
      desc: '创建后的状态,默认 PAUSED(暂停,不花钱;人工核对后再启用)',
      enum: ['PAUSED', 'ENABLED'],
    },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    buildPayload(flags); // 本地校验全部参数,坏参数不消耗 API
    if (strFlag(flags, 'end')) validateDateRange(flags);
  },
  describe: (flags) => {
    const state = strFlag(flags, 'state') ?? 'PAUSED';
    return (
      `在广告账户 ${strFlag(flags, 'profileId')} 创建 SP 广告活动「${strFlag(flags, 'name')}」:` +
      `${strFlag(flags, 'targetingType') === 'AUTO' ? '自动' : '手动'}投放,` +
      `日预算 ${strFlag(flags, 'dailyBudget')},${strFlag(flags, 'start')} 开始` +
      `${strFlag(flags, 'end') ? `、${strFlag(flags, 'end')} 结束` : '(长期)'},` +
      (state === 'ENABLED' ? '创建后【立即投放花钱】' : '创建后为暂停状态(不花钱)')
    );
  },
  dryRun: async (ctx) => {
    requireProfileId(ctx.flags);
    const payload = buildPayload(ctx.flags);
    return {
      dry_run_note:
        '以下是将提交给亚马逊的完整内容(广告 API 无服务端预校验,此为客户端预览)。' +
        '确认无误后把 --dry-run 换成 --confirm 执行。首次使用建议先在测试账户验证(ads test-account)。',
      endpoint: 'POST /sp/campaigns',
      payload,
      reminder:
        (payload['campaigns'] as Array<Record<string, unknown>>)[0]?.['state'] === 'ENABLED'
          ? '⚠️ 你指定了 --state ENABLED:创建成功后广告会立即开始投放花钱!'
          : '创建后为暂停状态,不会花钱,需在广告后台手动启用。',
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const payload = buildPayload(ctx.flags);
    ctx.progress('· 正在创建广告活动...');
    const resp = await ctx.adsClient.request('POST', '/sp/campaigns', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spCampaign,
      body: payload,
      extraHeaders: { Prefer: 'return=representation' },
    });

    const campaignId = extractCampaignId(resp);
    const requestedState = strFlag(ctx.flags, 'state') ?? 'PAUSED';
    if (requestedState === 'PAUSED' && campaignId) {
      return {
        campaignId,
        created: resp,
        enabled: false,
        note:
          '已保持暂停状态，不会产生花费。启用必须作为独立写操作先预览：' +
          `ads campaign-state --profile-id ${profileId} --campaign-id ${campaignId} --state ENABLED --dry-run`,
      };
    }

    return { ...(campaignId ? { campaignId } : {}), result: resp };
  },
};
