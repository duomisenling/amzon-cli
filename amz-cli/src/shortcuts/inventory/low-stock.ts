// inventory low-stock —— 一步列出"快断货、该补了"的品(按可售天数排紧急度)
//
// 背景:比 restock-candidates(已断货)更早一步——盯"还有货但可售天数不多"的品,
//   及时补货,既避免断货丢排名,也避开低库存费。数据就在库龄那份报告里(days-of-supply)。
//
// 数据源:Reports API GET_FBA_INVENTORY_PLANNING_DATA(与 inventory aged 同一份报告)
// 角色:Inventory and Order Tracking

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import { runReportRows } from '../report/infra.js';

type Row = Record<string, string>;

function rawCell(row: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return undefined;
}
function num(row: Row, keys: string[]): number {
  const v = rawCell(row, keys);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface LowStockItem {
  sku?: string;
  asin?: string;
  name?: string;
  available: number;
  daysOfSupply: number;
  recommendedReplenishmentQty?: number;
}

export interface LowStockOptions {
  /** 可售天数 <= 该值算"快断货",默认 14 */
  maxDays: number;
  limit?: number;
}

/**
 * 纯过滤 + 排序:可售天数为有效数字且 <= maxDays 的品,按可售天数升序(最紧急在前)。
 * 没有可售天数(无销速/空值)的行跳过,避免把滞销品也当"快断货"。
 */
export function selectLowStock(rows: Row[], opts: LowStockOptions): LowStockItem[] {
  const items: LowStockItem[] = [];
  for (const row of rows) {
    const dosCell = rawCell(row, ['days-of-supply']);
    if (dosCell === undefined) continue;
    const daysOfSupply = Number(dosCell);
    if (!Number.isFinite(daysOfSupply) || daysOfSupply > opts.maxDays) continue;
    const rec = rawCell(row, [
      'Recommended ship-in quantity',
      'recommended-replenishment-qty',
      'recommended-ship-in-qty',
    ]);
    items.push({
      sku: rawCell(row, ['sku', 'seller-sku']),
      asin: rawCell(row, ['asin']),
      name: rawCell(row, ['product-name'])?.slice(0, 60),
      available: num(row, ['available', 'afn-fulfillable-quantity']),
      daysOfSupply,
      ...(rec !== undefined && Number.isFinite(Number(rec))
        ? { recommendedReplenishmentQty: Number(rec) }
        : {}),
    });
  }
  items.sort((a, b) => a.daysOfSupply - b.daysOfSupply);
  return typeof opts.limit === 'number' ? items.slice(0, opts.limit) : items;
}

export const inventoryLowStock: ToolDefinition = {
  service: 'inventory',
  command: 'low-stock',
  description: '一步列出快断货、该补货的品(按可售天数排紧急度;默认可售天数≤14)',
  mutation: 'none',
  isAsync: true,
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'max-days', desc: '可售天数 <= 该值算快断货,默认 14(0-365)' },
    { name: 'limit', desc: '最多返回多少条(可选,默认全部,按可售天数升序)' },
    { name: 'timeout', desc: '报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'maxDays', '--max-days', { min: 0, max: 365, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const maxDays = Number(strFlag(ctx.flags, 'maxDays') ?? 14);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    let items: LowStockItem[] = [];
    let note: string | undefined;
    try {
      const parsed = await runReportRows(ctx, 'GET_FBA_INVENTORY_PLANNING_DATA', mkt, {
        timeoutMinutes: timeout,
      });
      if (parsed.format !== 'tsv' || !parsed.rows) {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'inventory.low_stock_unparsable',
          hintAgent: 'report_to_human',
          hintHuman: '库存规划报告不是预期的表格格式,无法按可售天数筛选,请稍后重试或用 report run 手动查看。',
          message: `inventory planning report was not TSV (format=${parsed.format})`,
        });
      }
      items = selectLowStock(parsed.rows, { maxDays, limit });
    } catch (error) {
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = '库存规划报告为空(通常表示当前没有 FBA 库存),没有快断货的品。';
      } else {
        throw error;
      }
    }

    return {
      marketplace: mkt.country,
      maxDays,
      count: items.length,
      items,
      ...(note ? { note } : {}),
    };
  },
};
