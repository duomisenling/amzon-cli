// inventory stranded —— 一步列出"滞留库存"(FBA 有货但没有可售 listing,卖不出去)
//
// 背景:滞留库存(stranded)指仓库里有货、但 listing 失效/缺失,导致卖不出还占仓储、
//   还会累积库龄费。运营要定期揪出来重新上架或移除。原本要跑 stranded 报告再解析过滤,
//   这里收成一条命令。
//
// 数据源:Reports API GET_STRANDED_INVENTORY_UI_DATA
// 角色:Inventory and Order Tracking

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import { runReportRows } from '../report/infra.js';

type Row = Record<string, string>;

function num(row: Row, keys: string[]): number {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') {
      const v = Number(row[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  return 0;
}
function str(row: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return undefined;
}

export interface StrandedItem {
  sku?: string;
  asin?: string;
  name?: string;
  quantity: number;
  reason?: string;
}

export interface StrandedOptions {
  /** 至少多少滞留单位才列出,默认 1 */
  minUnits: number;
  limit?: number;
}

/** 纯过滤 + 排序:有滞留单位的 SKU,按滞留单位数降序。 */
export function selectStrandedInventory(rows: Row[], opts: StrandedOptions): StrandedItem[] {
  const items = rows
    .map((row): StrandedItem => ({
      sku: str(row, ['sku', 'seller-sku']),
      asin: str(row, ['asin']),
      name: str(row, ['product-name'])?.slice(0, 60),
      quantity: num(row, ['available-quantity', 'quantity', 'afn-fulfillable-quantity', 'available']),
      reason: str(row, ['status-primary', 'stranded-reason', 'status-secondary', 'error-message']),
    }))
    .filter((i) => i.quantity >= opts.minUnits)
    .sort((a, b) => b.quantity - a.quantity);
  return typeof opts.limit === 'number' ? items.slice(0, opts.limit) : items;
}

export const inventoryStranded: ToolDefinition = {
  service: 'inventory',
  command: 'stranded',
  description: '一步列出滞留库存(FBA 有货但 listing 失效卖不出去的 SKU),便于重新上架或移除',
  mutation: 'none',
  isAsync: true,
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'min-units', desc: '至少多少滞留单位才列出,默认 1(0-100000)' },
    { name: 'limit', desc: '最多返回多少条(可选,默认全部,按滞留单位数降序)' },
    { name: 'timeout', desc: '报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'minUnits', '--min-units', { min: 0, max: 100_000, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const minUnits = Number(strFlag(ctx.flags, 'minUnits') ?? 1);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    let items: StrandedItem[] = [];
    let note: string | undefined;
    try {
      const parsed = await runReportRows(ctx, 'GET_STRANDED_INVENTORY_UI_DATA', mkt, {
        timeoutMinutes: timeout,
      });
      if (parsed.format !== 'tsv' || !parsed.rows) {
        // 没有滞留库存时报告可能是空表/非表格——按"无滞留"处理,不报错。
        note = '滞留库存报告为空,当前没有滞留库存。';
      } else {
        items = selectStrandedInventory(parsed.rows, { minUnits, limit });
      }
    } catch (error) {
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = '滞留库存报告为空,当前没有滞留库存。';
      } else {
        throw error;
      }
    }

    return {
      marketplace: mkt.country,
      minUnits,
      count: items.length,
      items,
      ...(note ? { note } : {}),
    };
  },
};
