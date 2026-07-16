// auth whoami —— 验证凭证链路,列出该账号参与的市场
//
// 用途:装好 CLI 后的第一条命令;凭证/网络/权限任何一环有问题,
// 这里最先暴露。等价于 scripts/hello.mjs 的正式版。
// API: Sellers API v1 getMarketplaceParticipations(GET,只读,无参数)

import type { ToolDefinition } from '../../tools/types.js';
import { marketplaceById } from '../../internal/client/regions.js';

interface Participation {
  marketplace?: { id?: string; countryCode?: string; name?: string };
  participation?: { isParticipating?: boolean };
}

export const authWhoami: ToolDefinition = {
  service: 'auth',
  command: 'whoami',
  description: '验证凭证是否有效,列出当前账号参与的所有市场',
  mutation: 'none',
  roles: ['Selling Partner Insights'],
  flags: [],
  execute: async (ctx) => {
    ctx.progress('· 正在验证凭证并查询市场参与情况...');
    const resp = (await ctx.client.get('/sellers/v1/marketplaceParticipations')) as {
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
    return { markets };
  },
};
