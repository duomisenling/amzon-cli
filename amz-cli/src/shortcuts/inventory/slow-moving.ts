// inventory slow-moving —— 一步列出"周转慢/压货"的品(货能卖,但按销速要卖很久)
//
// 背景:和 aged(看库龄=放了多久)是互补的另一个角度——slow-moving 看"周转/可售天数"
//   (按当前销速还要卖多少天卖完)。真机实测:亚马逊自算的 estimated-excess-quantity 常年是 0,
//   真正能反映压货的是 days-of-supply——本店有一批 SKU 可售天数 200~366 天、周转率
//   (sell-through)只有 0.03~0.2,货不老但卖得极慢、压了太多。本命令按"可售天数 >= 阈值"
//   (默认 90 天)筛,按可售天数降序,最压货的排最前。
//
// 数据源:Reports API GET_FBA_INVENTORY_PLANNING_DATA(与 inventory aged / low-stock 同一份报告)
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
function optNum(row: Row, keys: string[]): number | undefined {
  const v = rawCell(row, keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface SlowMovingItem {
  sku?: string;
  asin?: string;
  name?: string;
  available: number;
  daysOfSupply: number;
  sellThrough?: number;
  excessQuantity?: number;
  estStorageCostNextMonth?: number;
}

export interface SlowMovingOptions {
  /** 可售天数 >= 该值算周转慢/压货,默认 90 */
  minDaysSupply: number;
  limit?: number;
}

/**
 * 纯过滤 + 排序:可售天数(days-of-supply)>= 阈值的 SKU,按可售天数降序(最压货在前)。
 * 可售天数为空(通常是刚上架、数据不足)的行跳过。excessQuantity 仅作参考一并带出。
 */
export function selectSlowMoving(rows: Row[], opts: SlowMovingOptions): SlowMovingItem[] {
  const items: SlowMovingItem[] = [];
  for (const row of rows) {
    const daysOfSupply = optNum(row, ['days-of-supply']);
    if (daysOfSupply === undefined || daysOfSupply < opts.minDaysSupply) continue;
    const est = optNum(row, ['estimated-storage-cost-next-month']);
    const excess = optNum(row, ['estimated-excess-quantity']);
    items.push({
      sku: rawCell(row, ['sku', 'seller-sku']),
      asin: rawCell(row, ['asin']),
      name: rawCell(row, ['product-name'])?.slice(0, 60),
      available: num(row, ['available', 'afn-fulfillable-quantity']),
      daysOfSupply,
      sellThrough: optNum(row, ['sell-through']),
      ...(excess !== undefined ? { excessQuantity: excess } : {}),
      ...(est !== undefined ? { estStorageCostNextMonth: est } : {}),
    });
  }
  items.sort((a, b) => b.daysOfSupply - a.daysOfSupply);
  return typeof opts.limit === 'number' ? items.slice(0, opts.limit) : items;
}

export const inventorySlowMoving: ToolDefinition = {
  service: 'inventory',
  command: 'slow-moving',
  description: '一步列出周转慢/压货的品(货能卖但可售天数过长,按可售天数降序;默认>90天)',
  mutation: 'none',
  isAsync: true,
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'min-days-supply', desc: '可售天数 >= 该值算周转慢/压货,默认 90(1-3650)' },
    { name: 'limit', desc: '最多返回多少条(可选,默认全部,按可售天数降序)' },
    { name: 'timeout', desc: '报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'minDaysSupply', '--min-days-supply', { min: 1, max: 3650, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const minDaysSupply = Number(strFlag(ctx.flags, 'minDaysSupply') ?? 90);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    let items: SlowMovingItem[] = [];
    let note: string | undefined;
    try {
      const parsed = await runReportRows(ctx, 'GET_FBA_INVENTORY_PLANNING_DATA', mkt, {
        timeoutMinutes: timeout,
      });
      if (parsed.format !== 'tsv' || !parsed.rows) {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'inventory.slow_moving_unparsable',
          hintAgent: 'report_to_human',
          hintHuman: '库存规划报告不是预期的表格格式,无法按可售天数筛选,请稍后重试或用 report run 手动查看。',
          message: `inventory planning report was not TSV (format=${parsed.format})`,
        });
      }
      items = selectSlowMoving(parsed.rows, { minDaysSupply, limit });
    } catch (error) {
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = '库存规划报告为空(通常表示当前没有 FBA 库存),没有可判断的压货。';
      } else {
        throw error;
      }
    }

    return {
      marketplace: mkt.country,
      minDaysSupply,
      count: items.length,
      items,
      ...(note ? { note } : {}),
    };
  },
};
