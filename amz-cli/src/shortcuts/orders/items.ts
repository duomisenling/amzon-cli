// orders items —— 查看某个订单买了什么(SKU / 数量 / 单价)
//
// API: Orders API v0 getOrderItems
//   GET /orders/v0/orders/{orderId}/orderItems
// (2026-07-13 从官方 OpenAPI 规范核实;OrderItem 关键字段:
//  SellerSKU / ASIN / QuantityOrdered / QuantityShipped / ItemPrice / Title)
// 角色:Inventory and Order Tracking
// 输出经 sanitize.ts 白名单剥离。

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { OPTIONAL_MARKETPLACE_FLAG, optionalRegion, strFlag } from '../common.js';
import { sanitizeOrderItem } from './sanitize.js';

interface GetOrderItemsResponse {
  payload?: {
    AmazonOrderId?: string;
    OrderItems?: Array<Record<string, unknown>>;
    NextToken?: string;
  };
}

/** 亚马逊订单号格式:3-7-7(如 111-1234567-1234567)。 */
const ORDER_ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;

export function validateOrderId(flags: Record<string, unknown>): void {
  const orderId = strFlag(flags, 'orderId');
  if (!orderId || !ORDER_ID_PATTERN.test(orderId)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_order_id',
      param: '--order-id',
      hintAgent: 'fix_param',
      hintHuman: `订单号格式不对:应为 3-7-7 位数字格式,如 111-1234567-1234567(收到:"${orderId ?? ''}")。`,
      message: `--order-id must match 3-7-7 digit format, got: ${orderId ?? '(empty)'}`,
    });
  }
}

export const ordersItems: ToolDefinition = {
  service: 'orders',
  command: 'items',
  description: '查看订单包含的商品明细(SKU/ASIN/数量/单价,不含买家个人信息)',
  mutation: 'none',
  roles: ['Inventory and Order Tracking'],
  flags: [
    { name: 'order-id', desc: '亚马逊订单号,如 111-1234567-1234567(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
    { name: 'next-token', desc: '分页游标(上一页返回的 nextToken)' },
  ],
  validate: validateOrderId,
  execute: async (ctx) => {
    const orderId = strFlag(ctx.flags, 'orderId')!;
    ctx.progress(`· 正在查询订单 ${orderId} 的商品明细...`);
    const resp = (await ctx.client.get(
      `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      strFlag(ctx.flags, 'nextToken') ? { NextToken: strFlag(ctx.flags, 'nextToken') } : undefined,
      optionalRegion(ctx.flags),
    )) as GetOrderItemsResponse;
    const items = (resp.payload?.OrderItems ?? []).map(sanitizeOrderItem);
    return {
      orderId: resp.payload?.AmazonOrderId ?? orderId,
      count: items.length,
      items,
      ...(resp.payload?.NextToken ? { nextToken: resp.payload.NextToken } : {}),
    };
  },
};
