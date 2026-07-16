// pricing foep —— 查自己 SKU 的 Buy Box 预期价(Featured Offer Expected Price)
//
// "要把价格降到多少才能拿到 Buy Box" 的官方参考值。
// API: Product Pricing API 2022-05-01 getFeaturedOfferExpectedPriceBatch
//   POST /batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice
// 请求结构(2026-07-13 从官方 OpenAPI 规范核实):
//   body.requests[] 每项必须带 marketplaceId / sku / method:"GET"(官方 sandbox 示例)/ uri;
//   结果状态枚举:VALID_FOEP / NO_COMPETING_OFFERS / OFFER_NOT_ELIGIBLE /
//               OFFER_NOT_FOUND / ASIN_NOT_ELIGIBLE
// 角色:Pricing

import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace } from '../common.js';
import { mapBatchResults, parseIdList, type BatchResponse } from './batch.js';

const FOEP_URI = '/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice';

export const pricingFoep: ToolDefinition = {
  service: 'pricing',
  command: 'foep',
  description: '查自己 SKU 的 Buy Box 预期价(FOEP:降到什么价位有望拿到 Buy Box)',
  mutation: 'none',
  roles: ['Pricing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'skus', desc: '自己店铺的 SKU 列表,逗号分隔(必填)', required: true },
  ],
  validate: (flags) => {
    parseIdList(flags, 'skus', '--skus', '个 SKU');
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const skus = parseIdList(ctx.flags, 'skus', '--skus', '个 SKU');

    ctx.progress(`· 正在查询 ${skus.length} 个 SKU 的 Buy Box 预期价(${mkt.country})...`);

    const resp = (await ctx.client.request(
      'POST',
      '/batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice',
      {
        retry5xx: true,
        body: {
          requests: skus.map((sku) => ({
            marketplaceId: mkt.id,
            sku,
            method: 'GET', // batch 内层 method 固定 GET(官方 sandbox 示例核实)
            uri: FOEP_URI,
          })),
        },
        region: mkt.region,
      },
    )) as BatchResponse;

    const results = mapBatchResults(resp, skus, 'sku', 'result');
    return { marketplace: mkt.country, count: results.length, results };
  },
};
