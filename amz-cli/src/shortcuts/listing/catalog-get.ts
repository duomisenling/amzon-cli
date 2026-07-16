// listing get —— 按 ASIN 查单个商品的完整目录信息
//
// API: Catalog Items API 2022-04-01 getCatalogItem
//   GET /catalog/2022-04-01/items/{asin}
// (2026-07-13 从官方 OpenAPI 规范核实:path 参数 asin,query 参数
//  marketplaceIds 必填、includedData 可选默认 summaries)
// 角色:Product Listing

import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';
import { simplifyItem, validateCatalogIncludedData } from './catalog-search.js';

export const listingGet: ToolDefinition = {
  service: 'listing',
  command: 'get',
  description:
    '按 ASIN 查任意商品(含竞品)的公开目录详情:标题/品牌/图片/BSR 类目排名等。注意 BSR 是排名不是销量,私有数据(销量/库存)拿不到',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'asin', desc: '商品 ASIN(必填)', required: true },
    {
      name: 'include',
      desc: '返回的数据集,逗号分隔。默认 summaries,images,salesRanks(常用组合)',
    },
  ],
  validate: (flags) => {
    validateCatalogIncludedData(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const asin = (strFlag(ctx.flags, 'asin') ?? '').toUpperCase();
    const include = strFlag(ctx.flags, 'include') ?? 'summaries,images,salesRanks';
    const extraSets = include.split(',').map((s) => s.trim());

    ctx.progress(`· 正在查询 ${asin} 在 ${mkt.name}(${mkt.country})的目录详情...`);

    const item = (await ctx.client.get(
      `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
      { marketplaceIds: mkt.id, includedData: include },
      mkt.region,
    )) as Record<string, unknown>;

    return { marketplace: mkt.country, item: simplifyItem(item, extraSets) };
  },
};
