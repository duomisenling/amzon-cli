// shipments list / items —— FBA 货件状态查询(只读)
//
// API: Fulfillment Inbound API v0(2026-07-14 官方 OpenAPI 核实)
//   GET /fba/inbound/v0/shipments                     getShipments
//     必填 MarketplaceId + QueryType(SHIPMENT|DATE_RANGE|NEXT_TOKEN)
//     ShipmentStatusList 枚举:WORKING/READY_TO_SHIP/SHIPPED/RECEIVING/
//       CANCELLED/DELETED/CLOSED/ERROR/IN_TRANSIT/DELIVERED/CHECKED_IN
//   GET /fba/inbound/v0/shipments/{shipmentId}/items  getShipmentItemsByShipmentId
//     响应:SellerSKU / QuantityShipped / QuantityReceived
//
// 注意:货件的"确认/取消"等写操作按规格 §7.3 明确暂缓(不可撤销),只做查询。
// 角色:Amazon Fulfillment

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { OPTIONAL_MARKETPLACE_FLAG, optionalRegion, resolveMarketplace, strFlag } from '../common.js';

const SHIPMENT_STATUSES = [
  'WORKING', 'READY_TO_SHIP', 'SHIPPED', 'RECEIVING', 'CANCELLED',
  'DELETED', 'CLOSED', 'ERROR', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN',
];

// 运营最常关心的"进行中"状态组合(默认查这些)
const ACTIVE_STATUSES = 'WORKING,READY_TO_SHIP,SHIPPED,IN_TRANSIT,DELIVERED,CHECKED_IN,RECEIVING';

export const shipmentsList: ToolDefinition = {
  service: 'shipments',
  command: 'list',
  description: 'FBA 货件列表:发了什么货、到哪一步了(默认列进行中的货件)',
  mutation: 'none',
  roles: ['Amazon Fulfillment'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    {
      name: 'status',
      desc: `按状态过滤,逗号分隔,默认查全部进行中。可选:${SHIPMENT_STATUSES.join(' | ')}`,
    },
    { name: 'shipment-ids', desc: '按货件编号精确查,逗号分隔(如 FBA15XXXX)' },
    { name: 'next-token', desc: '分页游标(上一页返回的 nextToken)' },
  ],
  validate: (flags) => {
    const status = strFlag(flags, 'status');
    if (status) {
      for (const s of status.split(',').map((x) => x.trim().toUpperCase())) {
        if (!SHIPMENT_STATUSES.includes(s)) {
          throw new AmzError({
            type: 'invalid_param',
            subtype: 'invalid_shipment_status',
            param: '--status',
            hintAgent: 'fix_param',
            hintHuman: `货件状态 "${s}" 无效。可选:${SHIPMENT_STATUSES.join(' / ')}`,
            message: `invalid shipment status: ${s}`,
          });
        }
      }
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const shipmentIds = strFlag(ctx.flags, 'shipmentIds');
    const nextToken = strFlag(ctx.flags, 'nextToken');
    const status = strFlag(ctx.flags, 'status')?.toUpperCase() ?? ACTIVE_STATUSES;

    ctx.progress(`· 正在查询 ${mkt.country} 的 FBA 货件...`);

    const resp = (await ctx.client.get('/fba/inbound/v0/shipments', {
      MarketplaceId: mkt.id,
      QueryType: nextToken ? 'NEXT_TOKEN' : 'SHIPMENT',
      ...(nextToken
        ? { NextToken: nextToken }
        : shipmentIds
          ? { ShipmentIdList: shipmentIds }
          : { ShipmentStatusList: status }),
    }, mkt.region)) as {
      payload?: {
        ShipmentData?: Array<Record<string, unknown>>;
        NextToken?: string;
      };
    };

    const shipments = (resp.payload?.ShipmentData ?? []).map((s) => ({
      shipmentId: s['ShipmentId'],
      name: s['ShipmentName'],
      status: s['ShipmentStatus'],
      destinationFC: s['DestinationFulfillmentCenterId'],
    }));

    return {
      marketplace: mkt.country,
      count: shipments.length,
      shipments,
      ...(resp.payload?.NextToken ? { nextToken: resp.payload.NextToken } : {}),
    };
  },
};

export const shipmentsItems: ToolDefinition = {
  service: 'shipments',
  command: 'items',
  description: '查某个货件的商品明细:发了多少件、亚马逊收了多少件',
  mutation: 'none',
  roles: ['Amazon Fulfillment'],
  flags: [
    { name: 'shipment-id', desc: '货件编号,如 FBA15XXXX(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
    { name: 'next-token', desc: '分页游标(上一页返回的 nextToken)' },
  ],
  execute: async (ctx) => {
    const shipmentId = strFlag(ctx.flags, 'shipmentId')!;
    ctx.progress(`· 正在查询货件 ${shipmentId} 的明细...`);
    const resp = (await ctx.client.get(
      `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`,
      strFlag(ctx.flags, 'nextToken') ? { NextToken: strFlag(ctx.flags, 'nextToken') } : undefined,
      optionalRegion(ctx.flags),
    )) as {
      payload?: { ItemData?: Array<Record<string, unknown>>; NextToken?: string };
    };
    const items = (resp.payload?.ItemData ?? []).map((it) => ({
      sku: it['SellerSKU'],
      shipped: it['QuantityShipped'],
      received: it['QuantityReceived'],
    }));
    return {
      shipmentId,
      count: items.length,
      items,
      ...(resp.payload?.NextToken ? { nextToken: resp.payload.NextToken } : {}),
    };
  },
};
