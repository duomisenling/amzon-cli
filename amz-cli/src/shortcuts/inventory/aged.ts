// inventory aged —— 一步按"库龄"(货在仓里放了多久)列出老库存,对齐 ERP 的库龄档
//
// 背景:ERP 的"滞销"看库龄——货在 FBA 仓里存放的天数,分 0~30 / 31~60 / … 档,
//   超过某档就算老货,越老越贵(库龄附加费 / 长期仓储费)。运营要定期揪出来清货。
//   本命令按"库龄 >= 阈值天数"筛,并列出各库龄档明细(和 ERP 那几列对得上)。
//   注:另有 inventory slow-moving 从"周转/可售天数"角度看压货——库龄看放多久,周转看还要卖多久。
//
// 数据源:Reports API GET_FBA_INVENTORY_PLANNING_DATA(列名已真机核实)
// 角色:Inventory and Order Tracking

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import { runReportRows } from '../report/infra.js';

type Row = Record<string, string>;

// 库龄档(与报告真实列名对应,不重叠,合计=总库存)。lo=该档起始天数,用于按阈值取"更老的档"。
const AGE_BUCKETS: Array<{ key: string; label: string; lo: number }> = [
  { key: 'inv-age-0-to-30-days', label: '0-30', lo: 0 },
  { key: 'inv-age-31-to-60-days', label: '31-60', lo: 31 },
  { key: 'inv-age-61-to-90-days', label: '61-90', lo: 61 },
  { key: 'inv-age-91-to-180-days', label: '91-180', lo: 91 },
  { key: 'inv-age-181-to-270-days', label: '181-270', lo: 181 },
  { key: 'inv-age-271-to-365-days', label: '271-365', lo: 271 },
  { key: 'inv-age-365-plus-days', label: '365+', lo: 366 },
];

function rawCell(row: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return undefined;
}
function cellNum(row: Row, key: string): number {
  const v = row[key];
  const n = v === undefined || v === '' ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface AgedItem {
  sku?: string;
  asin?: string;
  name?: string;
  available: number;
  agedUnits: number;
  breakdown: Record<string, number>;
  estStorageCostNextMonth?: number;
}

export interface AgedOptions {
  /** 库龄 >= 该天数的单位算老货(按档取:>=90 即 91+ 天档) */
  minAgeDays: number;
  /** 老货单位数达到多少才列出,默认 1 */
  minUnits: number;
  limit?: number;
}

/**
 * 纯过滤 + 排序:把库龄 >= minAgeDays 的档单位数相加为 agedUnits,达标者按 agedUnits 降序。
 * breakdown 列出被计入的各库龄档单位数(>0 的档),和 ERP 库龄列对齐。
 */
export function selectAgedInventory(rows: Row[], opts: AgedOptions): AgedItem[] {
  const buckets = AGE_BUCKETS.filter((b) => b.lo >= opts.minAgeDays);
  const items: AgedItem[] = [];
  for (const row of rows) {
    const breakdown: Record<string, number> = {};
    let agedUnits = 0;
    for (const b of buckets) {
      const q = cellNum(row, b.key);
      if (q > 0) breakdown[b.label] = q;
      agedUnits += q;
    }
    if (agedUnits < opts.minUnits) continue;
    const estRaw = rawCell(row, ['estimated-storage-cost-next-month']);
    const est = estRaw !== undefined && Number.isFinite(Number(estRaw)) ? Number(estRaw) : undefined;
    items.push({
      sku: rawCell(row, ['sku', 'seller-sku']),
      asin: rawCell(row, ['asin']),
      name: rawCell(row, ['product-name'])?.slice(0, 60),
      available: cellNum(row, 'available') || cellNum(row, 'afn-fulfillable-quantity'),
      agedUnits,
      breakdown,
      ...(est !== undefined ? { estStorageCostNextMonth: est } : {}),
    });
  }
  items.sort((a, b) => b.agedUnits - a.agedUnits);
  return typeof opts.limit === 'number' ? items.slice(0, opts.limit) : items;
}

export const inventoryAged: ToolDefinition = {
  service: 'inventory',
  command: 'aged',
  description: '一步按库龄(在仓天数)列出老库存,对齐 ERP 库龄档;默认库龄>90天,列出各档明细',
  mutation: 'none',
  isAsync: true,
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'min-age-days', desc: '库龄 >= 该天数算老货,默认 90(按档取:30/60/90/180/270/365)' },
    { name: 'min-units', desc: '老货单位数达到多少才列出,默认 1(0-100000)' },
    { name: 'limit', desc: '最多返回多少条(可选,默认全部,按老货单位数降序)' },
    { name: 'timeout', desc: '报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'minAgeDays', '--min-age-days', { min: 0, max: 3650, integer: true });
    validateNumberFlag(flags, 'minUnits', '--min-units', { min: 0, max: 100_000, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const minAgeDays = Number(strFlag(ctx.flags, 'minAgeDays') ?? 90);
    const minUnits = Number(strFlag(ctx.flags, 'minUnits') ?? 1);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    let items: AgedItem[] = [];
    let note: string | undefined;
    try {
      const parsed = await runReportRows(ctx, 'GET_FBA_INVENTORY_PLANNING_DATA', mkt, {
        timeoutMinutes: timeout,
      });
      if (parsed.format !== 'tsv' || !parsed.rows) {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'inventory.aged_unparsable',
          hintAgent: 'report_to_human',
          hintHuman: '库存规划报告不是预期的表格格式,无法按库龄筛选,请稍后重试或用 report run 手动查看。',
          message: `inventory planning report was not TSV (format=${parsed.format})`,
        });
      }
      items = selectAgedInventory(parsed.rows, { minAgeDays, minUnits, limit });
    } catch (error) {
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = '库存规划报告为空(通常表示当前没有 FBA 库存),没有老库存。';
      } else {
        throw error;
      }
    }

    return {
      marketplace: mkt.country,
      minAgeDays,
      minUnits,
      count: items.length,
      items,
      ...(note ? { note } : {}),
    };
  },
};
