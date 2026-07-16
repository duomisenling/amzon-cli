// 订单数据 PII 剥离(规格 §7.1 红线:只查订单状态/SKU/数量,不碰买家 PII)
//
// 安全策略:白名单透传,而不是黑名单剔除。
// Orders API v0 的默认响应结构里定义了 ShippingAddress / BuyerInfo(买家姓名、
// 邮箱、地址—— 2026-07-13 从官方 OpenAPI 规范核实)。即使我们的应用没有受限
// 角色、亚马逊侧通常不下发完整 PII,CLI 也一律只透传下面白名单里的字段——
// 任何新字段(包括未来 API 新增的)默认不透出,想透出必须显式加进白名单。

/** Order 对象白名单(字段名与官方规范一致)。 */
const ORDER_FIELDS = [
  'AmazonOrderId',
  'SellerOrderId',
  'OrderStatus',
  'PurchaseDate',
  'LastUpdateDate',
  'OrderTotal',
  'NumberOfItemsShipped',
  'NumberOfItemsUnshipped',
  'FulfillmentChannel', // AFN=FBA / MFN=自发货
  'MarketplaceId',
  'SalesChannel',
  'ShipmentServiceLevelCategory',
  'IsPrime',
  'IsBusinessOrder',
  'IsReplacementOrder',
  'EarliestShipDate',
  'LatestShipDate',
] as const;

/** OrderItem 对象白名单。 */
const ORDER_ITEM_FIELDS = [
  'OrderItemId',
  'SellerSKU',
  'ASIN',
  'Title',
  'QuantityOrdered',
  'QuantityShipped',
  'ItemPrice',
  'ItemTax',
  'ConditionId',
  'IsGift',
] as const;

function pick(
  obj: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

export function sanitizeOrder(order: Record<string, unknown>): Record<string, unknown> {
  return pick(order, ORDER_FIELDS);
}

export function sanitizeOrderItem(item: Record<string, unknown>): Record<string, unknown> {
  return pick(item, ORDER_ITEM_FIELDS);
}
