// inventory list —— FBA 库存实时查询(秒回,不用等报告)
//
// API: FBA Inventory API v1 getInventorySummaries(2026-07-14 官方 OpenAPI 核实)
//   GET /fba/inventory/v1/summaries
//   必填:granularityType="Marketplace" + granularityId + marketplaceIds(最多1个)
//   可选:details=true(库存明细);sellerSkus 最多 50 个;nextToken(30 秒内有效)
//   限速:2/s burst 2
// 角色:Inventory and Order Tracking

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';

interface InventorySummary {
  asin?: string;
  fnSku?: string;
  sellerSku?: string;
  productName?: string;
  totalQuantity?: number;
  lastUpdatedTime?: string;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
    reservedQuantity?: { totalReservedQuantity?: number };
    unfulfillableQuantity?: { totalUnfulfillableQuantity?: number };
  };
}

export const inventoryList: ToolDefinition = {
  service: 'inventory',
  command: 'list',
  description: 'FBA 库存实时查询:可售/在途/预留/不可售(秒回;查全部或指定 SKU)',
  mutation: 'none',
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'skus', desc: '只查这些 SKU,逗号分隔,最多 50 个(可选,默认全部)' },
    { name: 'next-token', desc: '分页游标(注意:仅 30 秒内有效,拿到要立即用)' },
  ],
  validate: (flags) => {
    const skus = strFlag(flags, 'skus')?.split(',').map((s) => s.trim()).filter(Boolean);
    if (skus && (skus.length < 1 || skus.length > 50)) {
      throw new AmzError({
        type: 'invalid_param', subtype: 'invalid_sku_count', param: '--skus', hintAgent: 'fix_param',
        hintHuman: '--skus 一次必须提供 1 到 50 个 SKU。', message: `--skus count must be 1-50, got ${skus.length}`,
      });
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const skus = strFlag(ctx.flags, 'skus');

    ctx.progress(`· 正在查询 ${mkt.country} 的 FBA 实时库存...`);

    const resp = (await ctx.client.get('/fba/inventory/v1/summaries', {
      granularityType: 'Marketplace',
      granularityId: mkt.id,
      marketplaceIds: mkt.id,
      details: true,
      ...(skus ? { sellerSkus: skus } : {}),
      ...(strFlag(ctx.flags, 'nextToken') ? { nextToken: strFlag(ctx.flags, 'nextToken') } : {}),
    }, mkt.region)) as {
      payload?: { inventorySummaries?: InventorySummary[] };
      pagination?: { nextToken?: string };
    };

    const items = (resp.payload?.inventorySummaries ?? []).map((s) => ({
      sku: s.sellerSku,
      asin: s.asin,
      name: s.productName?.slice(0, 60),
      total: s.totalQuantity ?? 0,
      fulfillable: s.inventoryDetails?.fulfillableQuantity ?? 0,
      inbound:
        (s.inventoryDetails?.inboundWorkingQuantity ?? 0) +
        (s.inventoryDetails?.inboundShippedQuantity ?? 0) +
        (s.inventoryDetails?.inboundReceivingQuantity ?? 0),
      reserved: s.inventoryDetails?.reservedQuantity?.totalReservedQuantity ?? 0,
      unfulfillable: s.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0,
    }));

    return {
      marketplace: mkt.country,
      count: items.length,
      items,
      ...(resp.pagination?.nextToken
        ? { nextToken: resp.pagination.nextToken, note: 'nextToken 仅 30 秒有效,立即用 --next-token 翻页' }
        : {}),
    };
  },
};
