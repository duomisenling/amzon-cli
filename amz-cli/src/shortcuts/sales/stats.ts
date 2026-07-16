// sales stats —— 销售统计(按天/周/月聚合的订单数/销量/销售额)
//
// API: Sales API v1 getOrderMetrics(2026-07-14 从官方 OpenAPI 规范核实)
//   GET /sales/v1/orderMetrics
//   必填:marketplaceIds、interval(两个 ISO8601 时间用 -- 连接)、granularity
//   granularity 枚举:Hour/Day/Week/Month/Year/Total;Day 及以上须带 granularityTimeZone
//   可选:asin 与 sku 互斥;fulfillmentNetwork MFN|AFN;buyerType
//   响应字段:interval/unitCount/orderItemCount/orderCount/averageUnitPrice/totalSales
// 角色:Selling Partner Insights

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { daysAgoIso, resolveMarketplace, strFlag, validateIsoTimeRange, validateNumberFlag } from '../common.js';

const GRANULARITIES = ['Hour', 'Day', 'Week', 'Month', 'Year', 'Total'];

interface OrderMetricsInterval {
  interval?: string;
  unitCount?: number;
  orderItemCount?: number;
  orderCount?: number;
  averageUnitPrice?: { amount?: string; currencyCode?: string };
  totalSales?: { amount?: string; currencyCode?: string };
}

export const salesStats: ToolDefinition = {
  service: 'sales',
  command: 'stats',
  description: '销售统计:按天/周/月聚合的订单数、销量、销售额、客单价(默认最近 30 天按天)',
  mutation: 'none',
  roles: ['Selling Partner Insights'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'days', desc: '统计最近 N 天,默认 30(与 --start/--end 二选一)' },
    { name: 'start', desc: '开始时间 ISO 8601,如 2026-07-01T00:00:00Z' },
    { name: 'end', desc: '结束时间 ISO 8601(默认现在)' },
    {
      name: 'granularity',
      desc: '聚合粒度,默认 Day。可选:Hour | Day | Week | Month | Year | Total',
      enum: GRANULARITIES,
    },
    { name: 'asin', desc: '只统计某个 ASIN(与 --sku 互斥)' },
    { name: 'sku', desc: '只统计某个 SKU(与 --asin 互斥)' },
    { name: 'fulfillment', desc: '按发货渠道过滤:AFN(FBA)| MFN(自发货)', enum: ['AFN', 'MFN'] },
  ],
  validate: (flags) => {
    // granularity 的枚举校验由框架按 Flag.enum 统一完成
    if (strFlag(flags, 'asin') && strFlag(flags, 'sku')) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'conflicting_product_filter',
        param: '--sku',
        hintAgent: 'fix_param',
        hintHuman: '--asin 和 --sku 不能同时使用(亚马逊接口限制),请二选一。',
        message: '--asin and --sku are mutually exclusive',
      });
    }
    validateNumberFlag(flags, 'days', '--days', { min: 1, max: 365, integer: true });
    validateIsoTimeRange(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const granularity = strFlag(ctx.flags, 'granularity') ?? 'Day';

    // interval:两个 ISO8601 时间用 -- 连接(官方规范格式);整秒,UTC
    const end = strFlag(ctx.flags, 'end') ?? daysAgoIso(0);
    const start = strFlag(ctx.flags, 'start') ?? daysAgoIso(Number(strFlag(ctx.flags, 'days') ?? 30));

    ctx.progress(`· 正在统计 ${mkt.country} 的销售数据(${granularity})...`);

    const resp = (await ctx.client.get('/sales/v1/orderMetrics', {
      marketplaceIds: mkt.id,
      interval: `${start}--${end}`,
      granularity,
      ...(granularity !== 'Hour' ? { granularityTimeZone: 'UTC' } : {}),
      ...(strFlag(ctx.flags, 'asin') ? { asin: strFlag(ctx.flags, 'asin') } : {}),
      ...(strFlag(ctx.flags, 'sku') ? { sku: strFlag(ctx.flags, 'sku') } : {}),
      ...(strFlag(ctx.flags, 'fulfillment')
        ? { fulfillmentNetwork: strFlag(ctx.flags, 'fulfillment')!.toUpperCase() }
        : {}),
    }, mkt.region)) as { payload?: OrderMetricsInterval[] };

    const rows = (resp.payload ?? []).map((m) => ({
      interval: m.interval,
      orders: m.orderCount ?? 0,
      units: m.unitCount ?? 0,
      totalSales: m.totalSales ? `${m.totalSales.amount} ${m.totalSales.currencyCode}` : '0',
      avgUnitPrice: m.averageUnitPrice
        ? `${m.averageUnitPrice.amount} ${m.averageUnitPrice.currencyCode}`
        : '-',
    }));

    // 汇总行(Total 粒度时就一行,无需重复汇总)
    const summary =
      granularity === 'Total'
        ? undefined
        : {
            orders: rows.reduce((s, r) => s + r.orders, 0),
            units: rows.reduce((s, r) => s + r.units, 0),
          };

    return { marketplace: mkt.country, granularity, ...(summary ? { summary } : {}), metrics: rows };
  },
};
