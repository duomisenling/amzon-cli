// reimbursements list —— 一步汇总"亚马逊已赔给你的钱"(合计 + 按原因/按 SKU 拆分)
//
// 背景:亚马逊会因丢失/损坏/退货未退回/费用多扣等自动或手动赔款。运营要定期看
//   "最近赔了多少、主要因为什么、哪些 SKU 赔得多",既核对到账也发现异常损耗。
//   赔款报告是逐笔明细,这里收成一条命令:拉报告 → 按原因/SKU 汇总金额。
//
// 数据源:Reports API GET_FBA_REIMBURSEMENTS_DATA(需要时间范围)
// 角色:Inventory and Order Tracking
//
// 注:本命令只统计"已经赔付"的款项;找出"还没赔、可申诉"的差异是另一件事
//   (需交叉库存流水),不在本命令范围内。

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ReimbursementSummary {
  totalAmount: number;
  currency?: string;
  count: number;
  byReason: Array<{ reason: string; amount: number; count: number }>;
  topSkus: Array<{ sku: string; asin?: string; amount: number; count: number }>;
}

export interface ReimbursementOptions {
  /** topSkus 最多列几个,默认 20 */
  limit: number;
}

/** 纯聚合:逐笔赔款明细 → 合计金额 + 按原因拆分 + 赔得最多的 SKU(降序)。 */
export function summarizeReimbursements(rows: Row[], opts: ReimbursementOptions): ReimbursementSummary {
  let totalAmount = 0;
  let currency: string | undefined;
  const reasonMap = new Map<string, { amount: number; count: number }>();
  const skuMap = new Map<string, { asin?: string; amount: number; count: number }>();

  for (const row of rows) {
    const amount = num(row, ['amount-total', 'amount']);
    totalAmount += amount;
    currency = currency ?? str(row, ['currency-unit', 'currency']);

    const reason = str(row, ['reason']) ?? '未标注';
    const r = reasonMap.get(reason) ?? { amount: 0, count: 0 };
    r.amount += amount;
    r.count += 1;
    reasonMap.set(reason, r);

    const sku = str(row, ['sku', 'seller-sku', 'merchant-sku']);
    if (sku) {
      const s = skuMap.get(sku) ?? { asin: str(row, ['asin']), amount: 0, count: 0 };
      s.amount += amount;
      s.count += 1;
      skuMap.set(sku, s);
    }
  }

  const byReason = [...reasonMap.entries()]
    .map(([reason, v]) => ({ reason, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount);
  const topSkus = [...skuMap.entries()]
    .map(([sku, v]) => ({ sku, ...(v.asin ? { asin: v.asin } : {}), amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, opts.limit);

  return {
    totalAmount: round2(totalAmount),
    ...(currency ? { currency } : {}),
    count: rows.length,
    byReason,
    topSkus,
  };
}

export const reimbursementsList: ToolDefinition = {
  service: 'reimbursements',
  command: 'list',
  description: '一步汇总最近 N 天亚马逊已赔款项(合计金额 + 按原因/按 SKU 拆分)',
  mutation: 'none',
  isAsync: true,
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'days', desc: '统计最近 N 天的赔款,默认 30(1-365)' },
    { name: 'limit', desc: 'topSkus 最多列几个,默认 20(1-1000)' },
    { name: 'timeout', desc: '报告最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'days', '--days', { min: 1, max: 365, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 1000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const days = Number(strFlag(ctx.flags, 'days') ?? 30);
    const limit = Number(strFlag(ctx.flags, 'limit') ?? 20);
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    let summary: ReimbursementSummary = {
      totalAmount: 0,
      count: 0,
      byReason: [],
      topSkus: [],
    };
    let note: string | undefined;
    try {
      const parsed = await runReportRows(ctx, 'GET_FBA_REIMBURSEMENTS_DATA', mkt, {
        dataStartTime: daysAgoIso(days),
        dataEndTime: daysAgoIso(0),
        timeoutMinutes: timeout,
      });
      if (parsed.format !== 'tsv' || !parsed.rows) {
        note = `最近 ${days} 天没有赔款记录。`;
      } else {
        summary = summarizeReimbursements(parsed.rows, { limit });
      }
    } catch (error) {
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        note = `最近 ${days} 天没有赔款记录。`;
      } else {
        throw error;
      }
    }

    return {
      marketplace: mkt.country,
      windowDays: days,
      ...summary,
      ...(note ? { note } : {}),
    };
  },
};
