// orders list —— 查询订单列表(状态监控用,不含买家 PII)
//
// API: Orders API v0 getOrders
//   GET /orders/v0/orders
// 参数(2026-07-13 从官方 OpenAPI 规范核实):
//   MarketplaceIds 必填(注意 Orders v0 参数名是首字母大写);
//   CreatedAfter / LastUpdatedAfter 至少一个;
//   MaxResultsPerPage 1-100 默认 100;NextToken 分页;
//   OrderStatuses 枚举:PendingAvailability/Pending/Unshipped/PartiallyShipped/
//                      Shipped/InvoiceUnconfirmed/Canceled/Unfulfillable
// 角色:Inventory and Order Tracking
// 输出经 sanitize.ts 白名单剥离,绝不透传买家地址/姓名/邮箱。

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { daysAgoIso, resolveMarketplace, strFlag } from '../common.js';
import { sanitizeOrder } from './sanitize.js';

const ORDER_STATUSES = [
  'PendingAvailability',
  'Pending',
  'Unshipped',
  'PartiallyShipped',
  'Shipped',
  'InvoiceUnconfirmed',
  'Canceled',
  'Unfulfillable',
];

interface GetOrdersResponse {
  payload?: {
    Orders?: Array<Record<string, unknown>>;
    NextToken?: string;
  };
}

export const ordersList: ToolDefinition = {
  service: 'orders',
  command: 'list',
  description: '查询订单列表(状态/金额/件数;默认最近 7 天,不含买家个人信息)',
  mutation: 'none',
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'days', desc: '查最近 N 天的订单(默认 7;与 --created-after 二选一)' },
    { name: 'created-after', desc: '起始时间,ISO 8601,如 2026-07-01T00:00:00Z' },
    { name: 'updated-after', desc: '按最后更新时间过滤,ISO 8601(与 created 系互斥)' },
    {
      name: 'status',
      desc: `按订单状态过滤,逗号分隔。可选:${ORDER_STATUSES.join(' | ')}`,
    },
    { name: 'max', desc: '每页数量,1-100,默认 100' },
    { name: 'next-token', desc: '分页游标(上一页返回的 nextToken)' },
  ],
  validate: (flags) => {
    const status = strFlag(flags, 'status');
    if (status) {
      for (const s of status.split(',').map((x) => x.trim())) {
        if (!ORDER_STATUSES.includes(s)) {
          throw new AmzError({
            type: 'invalid_param',
            subtype: 'invalid_order_status',
            param: '--status',
            hintAgent: 'fix_param',
            hintHuman: `订单状态 "${s}" 无效。可选:${ORDER_STATUSES.join(' / ')}`,
            message: `invalid order status: ${s}`,
          });
        }
      }
    }
    const days = strFlag(flags, 'days');
    if (days !== undefined) {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0 || n > 365) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'invalid_days',
          param: '--days',
          hintAgent: 'fix_param',
          hintHuman: '--days 必须是 1 到 365 之间的数字。',
          message: `--days must be in [1,365], got: ${days}`,
        });
      }
    }
    const max = strFlag(flags, 'max');
    if (max !== undefined) {
      const n = Number(max);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'invalid_max_results',
          param: '--max',
          hintAgent: 'fix_param',
          hintHuman: '--max 必须是 1 到 100 之间的整数(亚马逊接口上限 100)。',
          message: `--max must be an integer in [1,100], got: ${max}`,
        });
      }
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const createdAfter = strFlag(ctx.flags, 'createdAfter');
    const updatedAfter = strFlag(ctx.flags, 'updatedAfter');

    // 时间条件:显式时间参数优先;都没给则默认最近 N 天(N 默认 7)
    let timeQuery: Record<string, string>;
    if (updatedAfter) {
      timeQuery = { LastUpdatedAfter: updatedAfter };
    } else if (createdAfter) {
      timeQuery = { CreatedAfter: createdAfter };
    } else {
      timeQuery = { CreatedAfter: daysAgoIso(Number(strFlag(ctx.flags, 'days') ?? 7)) };
    }

    ctx.progress(`· 正在查询 ${mkt.name}(${mkt.country})的订单...`);

    const resp = (await ctx.client.get('/orders/v0/orders', {
      MarketplaceIds: mkt.id,
      ...timeQuery,
      ...(strFlag(ctx.flags, 'status') ? { OrderStatuses: strFlag(ctx.flags, 'status') } : {}),
      ...(strFlag(ctx.flags, 'max') ? { MaxResultsPerPage: Number(strFlag(ctx.flags, 'max')) } : {}),
      ...(strFlag(ctx.flags, 'nextToken') ? { NextToken: strFlag(ctx.flags, 'nextToken') } : {}),
    }, mkt.region)) as GetOrdersResponse;

    const orders = (resp.payload?.Orders ?? []).map(sanitizeOrder);
    return {
      marketplace: mkt.country,
      count: orders.length,
      orders,
      ...(resp.payload?.NextToken ? { nextToken: resp.payload.NextToken } : {}),
    };
  },
};
