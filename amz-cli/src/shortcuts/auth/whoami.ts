// auth whoami —— 验证凭证链路,列出该账号参与的市场
//
// 用途:装好 CLI 后的第一条命令;凭证/网络/权限任何一环有问题,
// 这里最先暴露。等价于 scripts/hello.mjs 的正式版。
// API: Sellers API v1 getMarketplaceParticipations(GET,只读,无参数)

import type { ToolDefinition } from '../../tools/types.js';
import { marketplaceById, type Region } from '../../internal/client/regions.js';
import { strFlag } from '../common.js';

interface Participation {
  marketplace?: { id?: string; countryCode?: string; name?: string };
  participation?: { isParticipating?: boolean };
}

export const authWhoami: ToolDefinition = {
  service: 'auth',
  command: 'whoami',
  description:
    '验证凭证是否有效,列出当前账号参与的所有市场。' +
    'SP-API 凭证按区域隔离:默认只查 SP_API_REGION 指定的区域,查其他区域用 --region(需已配置该区域的 LWA_REFRESH_TOKEN_<区域>)',
  mutation: 'none',
  roles: ['Selling Partner Insights'],
  flags: [
    {
      name: 'region',
      desc:
        '要验证的区域(可选,默认 .env 的 SP_API_REGION):na 北美 | eu 欧洲 | fe 远东。' +
        '每个区域是独立凭证,eu 需要配置 LWA_REFRESH_TOKEN_EU',
      enum: ['na', 'eu', 'fe'],
    },
  ],
  execute: async (ctx) => {
    const region = strFlag(ctx.flags, 'region') as Region | undefined;
    ctx.progress(`· 正在验证${region ? ` ${region.toUpperCase()} 区域的` : ''}凭证并查询市场参与情况...`);
    const resp = (await ctx.client.get('/sellers/v1/marketplaceParticipations', undefined, region)) as {
      payload?: Participation[];
    };
    const markets = (resp.payload ?? []).map((p) => ({
      marketplaceId: p.marketplace?.id ?? '',
      country: p.marketplace?.countryCode ?? '',
      name: p.marketplace?.name ?? '',
      participating: p.participation?.isParticipating ?? false,
      // 标注是否为实际销售站点(区别于账号自带的内部/影子市场)
      isSalesChannel: p.marketplace?.id ? marketplaceById(p.marketplace.id) !== undefined : false,
    }));
    // 明确告知本次结果属于哪个区域,避免"为什么查不到欧盟站"的误判
    const effectiveRegion = region ?? ((process.env['SP_API_REGION'] || 'na').trim().toLowerCase());
    return {
      region: effectiveRegion,
      note: `以上是 ${effectiveRegion.toUpperCase()} 区域凭证参与的市场;其他区域用 --region eu / --region fe 单独验证`,
      markets,
    };
  },
};
