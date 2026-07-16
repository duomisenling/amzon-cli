// pricing competitive —— 竞品价格/Buy Box 概览(按 ASIN 批量)
//
// API: Product Pricing API 2022-05-01 getCompetitiveSummary
//   POST /batches/products/pricing/2022-05-01/items/competitiveSummary
// 请求结构(2026-07-13 从官方 OpenAPI 规范核实):
//   body.requests[] 每项必须带 asin / marketplaceId / includedData /
//   method:"GET" / uri:"/products/pricing/2022-05-01/items/competitiveSummary";
//   一批最多 20 个;响应按 {status, body} 逐项包裹。
//   includedData 枚举:featuredBuyingOptions / referencePrices /
//                     lowestPricedOffers / similarItems
// 角色:Pricing

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';
import { mapBatchResults, parseIdList, type BatchResponse } from './batch.js';

const INCLUDED = ['featuredBuyingOptions', 'referencePrices', 'lowestPricedOffers', 'similarItems'];
const COMPETITIVE_URI = '/products/pricing/2022-05-01/items/competitiveSummary';

export const pricingCompetitive: ToolDefinition = {
  service: 'pricing',
  command: 'competitive',
  description:
    '查任意 ASIN(含竞品)的公开 Buy Box/报价概览,一次最多 20 个。仅商品页公开的价格信息,不含卖家销量等私有数据',
  mutation: 'none',
  roles: ['Pricing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'asins', desc: 'ASIN 列表,逗号分隔,最多 20 个(必填)', required: true },
    {
      name: 'include',
      desc: `返回的数据集,逗号分隔,默认 featuredBuyingOptions,referencePrices。可选:${INCLUDED.join(',')}`,
    },
  ],
  validate: (flags) => {
    parseIdList(flags, 'asins', '--asins', '个 ASIN');
    const include = strFlag(flags, 'include');
    if (include) {
      for (const set of include.split(',').map((s) => s.trim())) {
        if (!INCLUDED.includes(set)) {
          throw new AmzError({
            type: 'invalid_param',
            subtype: 'invalid_included_data',
            param: '--include',
            hintAgent: 'fix_param',
            hintHuman: `--include 里的 "${set}" 无效。可选:${INCLUDED.join(' / ')}`,
            message: `invalid includedData value: ${set}`,
          });
        }
      }
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const asins = parseIdList(ctx.flags, 'asins', '--asins', '个 ASIN').map((a) => a.toUpperCase());
    const includedData = (strFlag(ctx.flags, 'include') ?? 'featuredBuyingOptions,referencePrices')
      .split(',')
      .map((s) => s.trim());

    ctx.progress(`· 正在查询 ${asins.length} 个 ASIN 在 ${mkt.name}(${mkt.country})的竞价概览...`);

    const resp = (await ctx.client.request(
      'POST',
      '/batches/products/pricing/2022-05-01/items/competitiveSummary',
      {
        retry5xx: true,
        body: {
          requests: asins.map((asin) => ({
            asin,
            marketplaceId: mkt.id,
            includedData,
            method: 'GET',
            uri: COMPETITIVE_URI,
          })),
        },
        region: mkt.region,
      },
    )) as BatchResponse;

    const results = mapBatchResults(resp, asins, 'asin', 'summary');
    return { marketplace: mkt.country, count: results.length, results };
  },
};
