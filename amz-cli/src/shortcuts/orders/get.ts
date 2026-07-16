// orders get —— 查看单个订单的状态详情(不含买家 PII)
//
// API: Orders API v0 getOrder
//   GET /orders/v0/orders/{orderId}
// (2026-07-13 从官方 OpenAPI 规范核实)
// 角色:Inventory and Order Tracking
// 输出经 sanitize.ts 白名单剥离。

import type { ToolDefinition } from '../../tools/types.js';
import { OPTIONAL_MARKETPLACE_FLAG, optionalRegion, strFlag } from '../common.js';
import { sanitizeOrder } from './sanitize.js';
import { validateOrderId } from './items.js';

interface GetOrderResponse {
  payload?: Record<string, unknown>;
}

export const ordersGet: ToolDefinition = {
  service: 'orders',
  command: 'get',
  description: '查看单个订单的状态详情(状态/金额/件数/发货渠道,不含买家个人信息)',
  mutation: 'none',
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'order-id', desc: '亚马逊订单号,如 111-1234567-1234567(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
  ],
  validate: validateOrderId,
  execute: async (ctx) => {
    const orderId = strFlag(ctx.flags, 'orderId')!;
    ctx.progress(`· 正在查询订单 ${orderId}...`);
    const resp = (await ctx.client.get(
      `/orders/v0/orders/${encodeURIComponent(orderId)}`,
      undefined,
      optionalRegion(ctx.flags),
    )) as GetOrderResponse;
    return { order: sanitizeOrder(resp.payload ?? {}) };
  },
};
