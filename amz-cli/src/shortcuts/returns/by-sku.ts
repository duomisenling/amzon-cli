// returns by-sku —— 一步把 FBA 客户退货按 SKU 聚合(揪出退货多的品)
//
// 背景:退货直接吃毛利,运营要定期看"最近哪些品退得最多、主要退货原因是什么"。
//   客户退货报告是逐笔明细(一行一次退货),要按 SKU 汇总数量、笔数、主因才有用。
//   这里把"跑退货报告 → 解析 → 按 SKU 分组统计"收成一条命令。
//
// 数据源:Reports API GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA(需要时间范围)
// 角色:Inventory and Order Tracking
//
// 注:本命令给的是退货"数量/笔数"。要算退货"率"需再除以同期销量(sales/report),
//   不在本命令内合并,以免多跑一份报告;需要率时可结合 sales stats 单独判断。

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { daysAgoIso, resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import { runReportRows } from '../report/infra.js';

type Row = Record<string, string>;

function str(row: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return undefined;
}
function num(row: Row, keys: string[]): number {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') {
      const v = Number(row[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  return 0;
}

export interface ReturnsBySku {
  sku?: string;
  asin?: string;
  name?: string;
  returnedUnits: number;
  returnEvents: number;
  topReason?: string;
  reasons: Record<string, number>;
}

export interface ReturnsOptions {
  /** 退货单位数达到多少才列出,默认 1 */
  minUnits: number;
  limit?: number;
}

/** 纯聚合:逐笔退货明细 → 按 SKU 汇总数量/笔数/主因,按退货单位数降序。 */
export function aggregateReturnsBySku(rows: Row[], opts: ReturnsOptions): ReturnsBySku[] {
  const bySku = new Map<string, ReturnsBySku>();
  for (const row of rows) {
    const sku = str(row, ['sku', 'seller-sku', 'merchant-sku']);
    if (!sku) continue;
    const qty = num(row, ['quantity']) || 1; // 明细行没有数量时按 1 笔计
    const reason = str(row, ['reason', 'detailed-disposition', 'customer-return-reason']) ?? '未标注';
    let agg = bySku.get(sku);
    if (!agg) {
      agg = {
        sku,
        asin: str(row, ['asin']),
        name: str(row, ['product-name'])?.slice(0, 60),
        returnedUnits: 0,
        returnEvents: 0,
        reasons: {},
      };
      bySku.set(sku, agg);
    }
    agg.returnedUnits += qty;
    agg.returnEvents += 1;
    agg.reasons[reason] = (agg.reasons[reason] ?? 0) + qty;
  }
  const items = [...bySku.values()]
    .map((agg) => {
      const topReason = Object.entries(agg.reasons).sort((a, b) => b[1] - a[1])[0]?.[0];
      return { ...agg, ...(topReason ? { topReason } : {}) };
    })
    .filter((i) => i.returnedUnits >= opts.minUnits)
    .sort((a, b) => b.returnedUnits - a.returnedUnits);
  return typeof opts.limit === 'number' ? items.slice(0, opts.limit) : items;
}

export const returnsBySku: ToolDefinition = {
  service: 'returns',
  command: 'by-sku',
  description: '一步把最近 N 天 FBA 客户退货按 SKU 聚合(退货数量/笔数/主因),揪出退货多的品',
  mutation: 'none',
  isAsync: true,
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'days', desc: '统计最近 N 天的退货,默认 30(1-365)' },
    { name: 'min-units', desc: '退货单位数达到多少才列出,默认 1(0-100000)' },
    { name: 'limit', desc: '最多返回多少条(可选,默认全部,按退货单位数降序)' },
    { name: 'timeout', desc: '报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'days', '--days', { min: 1, max: 365, integer: true });
    validateNumberFlag(flags, 'minUnits', '--min-units', { min: 0, max: 100_000, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const days = Number(strFlag(ctx.flags, 'days') ?? 30);
    const minUnits = Number(strFlag(ctx.flags, 'minUnits') ?? 1);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    let items: ReturnsBySku[] = [];
    let note: string | undefined;
    try {
      const parsed = await runReportRows(ctx, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', mkt, {
        dataStartTime: daysAgoIso(days),
        dataEndTime: daysAgoIso(0),
        timeoutMinutes: timeout,
      });
      if (parsed.format !== 'tsv' || !parsed.rows) {
        note = `最近 ${days} 天没有退货记录。`;
      } else {
        items = aggregateReturnsBySku(parsed.rows, { minUnits, limit });
      }
    } catch (error) {
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = `最近 ${days} 天没有退货记录。`;
      } else {
        throw error;
      }
    }

    return {
      marketplace: mkt.country,
      windowDays: days,
      minUnits,
      count: items.length,
      items,
      ...(note ? { note } : {}),
    };
  },
};
