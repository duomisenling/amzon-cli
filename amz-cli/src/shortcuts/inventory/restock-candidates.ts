// inventory restock-candidates —— 一步找出"以前好卖、现在断货/库存告急"的商品
//
// 背景:回答"哪些以前好卖的品现在断货了 / 需要补货"本质是两份数据的 JOIN,
//   而 Amazon 接口把它们拆在两处:库存要分页拉、销量只能靠报告出。以前 Agent 只能
//   逐页翻库存 + 跑销售报告 + 手动按 ASIN 对起来,一句话炸掉几十个工具调用。
// 本命令把这条链路固化到服务端,一条命令收敛:
//   1) FBA 实时库存(getInventorySummaries,命令内自动翻完所有页) → 每个 SKU 的可售/在途
//   2) 一次 Sales & Traffic 报告(GET_SALES_AND_TRAFFIC_REPORT,按子 ASIN) → 期间销量
//   3) 按子 ASIN JOIN:可售+在途 <= --stock-threshold 且 期间销量 >= --min-units 即补货候选
//
// API:FBA Inventory v1 getInventorySummaries + Reports 2021-06-30(见 inventory/list、report/infra)
// 角色:Inventory and Order Tracking + Selling Partner Insights

import { AmzError } from '../../internal/errs/errors.js';
import type { Region } from '../../internal/client/regions.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import {
  assertPageWithinLimit,
  daysAgoIso,
  resolveMarketplace,
  strFlag,
  validateNumberFlag,
} from '../common.js';
import {
  downloadReportDocument,
  requestReport,
  requireReportDocumentId,
  waitForReport,
} from '../report/infra.js';

interface InventorySummary {
  asin?: string;
  sellerSku?: string;
  productName?: string;
  totalQuantity?: number;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
  };
}

/** JOIN 用的最小库存视图。 */
export interface RestockInventoryItem {
  sku?: string;
  asin?: string;
  name?: string;
  fulfillable: number;
  inbound: number;
}

export interface RestockOptions {
  stockThreshold: number;
  minUnits: number;
  limit?: number;
}

export interface RestockCandidate {
  sku?: string;
  asin?: string;
  name?: string;
  fulfillable: number;
  inbound: number;
  available: number;
  unitsSold: number;
}

/**
 * 纯 JOIN + 筛选 + 排序,不碰 I/O(便于单测)。
 * 命中条件:可售+在途 <= stockThreshold(断货/告急) 且 期间销量 >= minUnits(以前好卖)。
 * 按期间销量降序,好卖又缺货的排在最前。
 */
export function selectRestockCandidates(
  items: RestockInventoryItem[],
  unitsByAsin: Record<string, number>,
  opts: RestockOptions,
): RestockCandidate[] {
  const candidates = items
    .map((it): RestockCandidate => ({
      sku: it.sku,
      asin: it.asin,
      name: it.name,
      fulfillable: it.fulfillable,
      inbound: it.inbound,
      available: it.fulfillable + it.inbound,
      unitsSold: it.asin ? unitsByAsin[it.asin] ?? 0 : 0,
    }))
    .filter((c) => c.available <= opts.stockThreshold && c.unitsSold >= opts.minUnits)
    .sort((a, b) => b.unitsSold - a.unitsSold);
  return typeof opts.limit === 'number' ? candidates.slice(0, opts.limit) : candidates;
}

/**
 * 从 Sales & Traffic 报告(JSON)里抽出「子 ASIN → 期间销量」。
 * asinGranularity=CHILD 时每行带 childAsin;容错父/通用 asin 字段,解析失败返回空表。
 */
export function parseUnitsByAsin(reportJsonText: string): Record<string, number> {
  const out: Record<string, number> = {};
  let data: unknown;
  try {
    data = JSON.parse(reportJsonText);
  } catch {
    return out;
  }
  const rows = (data as { salesAndTrafficByAsin?: unknown })?.salesAndTrafficByAsin;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const asin = r?.childAsin ?? r?.parentAsin ?? r?.asin;
    const units = Number(r?.salesByAsin?.unitsOrdered ?? 0);
    if (typeof asin === 'string' && asin) {
      out[asin] = (out[asin] ?? 0) + (Number.isFinite(units) ? units : 0);
    }
  }
  return out;
}

/** 命令内自动翻完所有页,拿到全店 FBA 实时库存(nextToken 立即消费,不受 30 秒过期影响)。 */
async function fetchAllInventory(
  ctx: ToolContext,
  marketplaceId: string,
  region: Region,
): Promise<RestockInventoryItem[]> {
  const items: RestockInventoryItem[] = [];
  let nextToken: string | undefined;
  let page = 0;
  do {
    page += 1;
    // 翻页熔断:防上游 nextToken 异常导致无限翻页
    assertPageWithinLimit(page, 'inventory.pagination_overflow', 'FBA 实时库存');
    ctx.progress(`· 正在拉取 FBA 实时库存(第 ${page} 页)...`);
    const resp = (await ctx.client.get(
      '/fba/inventory/v1/summaries',
      {
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
        details: true,
        ...(nextToken ? { nextToken } : {}),
      },
      region,
    )) as {
      payload?: { inventorySummaries?: InventorySummary[] };
      pagination?: { nextToken?: string };
    };
    for (const s of resp.payload?.inventorySummaries ?? []) {
      items.push({
        sku: s.sellerSku,
        asin: s.asin,
        name: s.productName?.slice(0, 60),
        fulfillable: s.inventoryDetails?.fulfillableQuantity ?? 0,
        inbound:
          (s.inventoryDetails?.inboundWorkingQuantity ?? 0) +
          (s.inventoryDetails?.inboundShippedQuantity ?? 0) +
          (s.inventoryDetails?.inboundReceivingQuantity ?? 0),
      });
    }
    nextToken = resp.pagination?.nextToken;
  } while (nextToken);
  return items;
}

export const restockCandidates: ToolDefinition = {
  service: 'inventory',
  command: 'restock-candidates',
  description:
    '一步找出"以前好卖、现在断货/库存告急"的补货候选(自动合并全店库存与近 N 天销量)',
  mutation: 'none',
  isAsync: true, // 内部要等一次销售报告生成(默认最长 10 分钟)
  roles: ['Inventory and Order Tracking', 'Selling Partner Insights'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'days', desc: '"以前好卖"看最近 N 天销量,默认 30(1-365)' },
    {
      name: 'stock-threshold',
      desc: '可售+在途 <= 该值算断货/告急,默认 0(即彻底断货);想含低库存可设 5/10',
    },
    { name: 'min-units', desc: '期间至少卖了多少件才算"好卖",默认 1(0-100000)' },
    { name: 'limit', desc: '最多返回多少条候选(可选,默认全部,按销量降序)' },
    { name: 'timeout', desc: '销售报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'days', '--days', { min: 1, max: 365, integer: true });
    validateNumberFlag(flags, 'stockThreshold', '--stock-threshold', {
      min: 0,
      max: 1_000_000,
      integer: true,
    });
    validateNumberFlag(flags, 'minUnits', '--min-units', { min: 0, max: 100_000, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const days = Number(strFlag(ctx.flags, 'days') ?? 30);
    const stockThreshold = Number(strFlag(ctx.flags, 'stockThreshold') ?? 0);
    const minUnits = Number(strFlag(ctx.flags, 'minUnits') ?? 1);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    // 1) 全店 FBA 实时库存(翻完所有页)
    const inventory = await fetchAllInventory(ctx, mkt.id, mkt.region);

    // 2) 近 N 天 Sales & Traffic 报告(按子 ASIN),拿每个 ASIN 的期间销量
    const start = daysAgoIso(days);
    const end = daysAgoIso(0);
    let unitsByAsin: Record<string, number> = {};
    let note: string | undefined;
    try {
      const reportId = await requestReport(ctx, 'GET_SALES_AND_TRAFFIC_REPORT', mkt, {
        dataStartTime: start,
        dataEndTime: end,
        reportOptions: { asinGranularity: 'CHILD' },
      });
      const status = await waitForReport(ctx, reportId, timeout, mkt.region);
      const text = await downloadReportDocument(ctx, requireReportDocumentId(status), mkt.region);
      unitsByAsin = parseUnitsByAsin(text);
    } catch (error) {
      // 时间段内没有任何销量时 Amazon 会 CANCELLED——不是故障,当作"期间无销量"处理。
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = `最近 ${days} 天没有销量数据(报告为空),因此没有"以前好卖"的补货候选。`;
      } else {
        throw error;
      }
    }

    // 3) JOIN + 筛选
    const candidates = selectRestockCandidates(inventory, unitsByAsin, {
      stockThreshold,
      minUnits,
      limit,
    });

    return {
      marketplace: mkt.country,
      salesWindowDays: days,
      stockThreshold,
      minUnits,
      scannedSkus: inventory.length,
      count: candidates.length,
      candidates,
      ...(note ? { note } : {}),
    };
  },
};
