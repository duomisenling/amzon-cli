// ads 命令组(只读)—— 广告账户与广告活动查询
//
// ⚠️ 规格 §7.4 原定广告全走官方 Ads MCP;项目负责人 2026-07-13 明确指示
//    在 CLI 中加入广告"读"能力(写操作仍不做,继续走 Ads MCP)。
//
// API(2026-07-13 核实):
//   GET  /v2/profiles                广告账户列表(不带 Scope 头)
//   POST /sp/campaigns/list          SP 广告活动列表(v3,vendor media type,
//                                    需要 Amazon-Advertising-API-Scope: profileId)
// 凭证:ADS_* 环境变量(与 SP-API 不同套,见 ads-client.ts 说明)

import { ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion, requireProfileId } from './common.js';

export const adsProfiles: ToolDefinition = {
  service: 'ads',
  command: 'profiles',
  description: '列出广告账户(profiles)。首次使用广告命令先跑这个拿 profileId;每个区域的账户要分别查(--region eu 查欧洲)',
  mutation: 'none',
  flags: [ADS_REGION_FLAG],
  execute: async (ctx) => {
    ctx.progress('· 正在查询广告账户列表...');
    const profiles = (await ctx.adsClient.request('GET', '/v2/profiles', { region: adsRegion(ctx.flags) })) as Array<
      Record<string, unknown>
    > | null;
    return { profiles: profiles ?? [] };
  },
};

export const adsCampaigns: ToolDefinition = {
  service: 'ads',
  command: 'campaigns',
  description: '列出 SP(商品推广)广告活动。需要 --profile-id(先用 ads profiles 查)',
  mutation: 'none',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    {
      name: 'state',
      desc: '按状态过滤(默认不过滤)',
      enum: ['ENABLED', 'PAUSED', 'ARCHIVED'],
    },
    { name: 'max', desc: '最多返回条数,默认 100' },
  ],
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const state = strFlag(ctx.flags, 'state');
    const max = Number(strFlag(ctx.flags, 'max') ?? 100);

    ctx.progress(`· 正在查询 profile ${profileId} 的 SP 广告活动...`);
    const resp = (await ctx.adsClient.request('POST', '/sp/campaigns/list', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spCampaign,
      retry5xx: true,
      body: {
        maxResults: max,
        ...(state ? { stateFilter: { include: [state] } } : {}),
      },
    })) as { campaigns?: Array<Record<string, unknown>>; nextToken?: string } | null;

    return {
      profileId,
      count: resp?.campaigns?.length ?? 0,
      campaigns: resp?.campaigns ?? [],
      ...(resp?.nextToken ? { nextToken: resp.nextToken } : {}),
    };
  },
};
