// listing mine —— 列出自己店铺的 listing(带状态/问题过滤)
// listing sku  —— 查自己店铺单个 SKU 的完整 listing 详情
//
// API: Listings Items API 2021-08-01(2026-07-13 从官方 OpenAPI 规范核实)
//   GET /listings/2021-08-01/items/{sellerId}            searchListingsItems
//   GET /listings/2021-08-01/items/{sellerId}/{sku}      getListingsItem
//   includedData 枚举:summaries/attributes/issues/offers/fulfillmentAvailability/
//                     procurement/relationships/productTypes;pageSize 最大 20
// 角色:Product Listing
//
// sellerId 来源:--seller-id flag,或 .env 里的 SELLER_ID。
// (提示:可用 pricing foep 响应里的 offerIdentifier.sellerId,或 Seller Central 查看)

import { AmzError } from '../../internal/errs/errors.js';
import type { SpApiClient } from '../../internal/client/client.js';
import type { Region } from '../../internal/client/regions.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';

export async function resolveSellerId(
  flags: Record<string, unknown>,
  region: Region | undefined,
  client?: SpApiClient,
): Promise<string> {
  // sellerId 按区域可能不同(实测:NA 与 EU 是两个不同的编号),
  // 本地模式优先级:--seller-id flag > SELLER_ID_<区域> > SELLER_ID(默认)。
  // Broker 模式必须以 Broker 按 STORE/region 返回的值为权威，防止令牌店铺与路径卖家不一致。
  const fromFlag = strFlag(flags, 'sellerId');
  const regionEnv = region ? process.env[`SELLER_ID_${region.toUpperCase()}`]?.trim() : undefined;
  const fromEnv = process.env['SELLER_ID']?.trim();
  const brokerMode = Boolean(process.env['BROKER_URL']?.trim());
  if (brokerMode && client) {
    const brokerSellerId = await client.getSellerId(region);
    if (!brokerSellerId) {
      throw missingSellerIdError(true);
    }
    if (fromFlag && fromFlag !== brokerSellerId) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'broker.seller_id_mismatch',
        param: '--seller-id',
        hintAgent: 'report_to_human',
        hintHuman:
          `--seller-id 与 Broker 为当前店铺/区域返回的 Seller ID 不一致。` +
          'CLI 已拒绝执行,请检查 --account、--marketplace 或联系管理员核对 Broker 配置。',
        message: `explicit sellerId does not match Broker sellerId for region ${region ?? 'default'}`,
      });
    }
    return brokerSellerId;
  }

  // 本地凭证不会携带 Seller ID；缺少显式配置时应立即报错，不能为一个
  // 注定取不到的值先换发 LWA token，否则会掩盖真正的配置问题。
  const sellerId = fromFlag ?? (regionEnv || undefined) ?? (fromEnv || undefined);
  if (!sellerId) {
    throw missingSellerIdError(false);
  }
  return sellerId;
}

function missingSellerIdError(brokerMode: boolean): AmzError {
  return new AmzError({
    type: 'invalid_param',
    subtype: 'missing_seller_id',
    param: '--seller-id',
    hintAgent: brokerMode ? 'report_to_human' : 'fix_param',
    hintHuman:
      (brokerMode
        ? 'Broker 没有返回当前店铺/区域的卖家编号:请联系管理员配置 SELLER_ID_<店铺>_<区域>。'
        : '缺少卖家编号:请用 --seller-id 传入,或在 .env 里配置 SELLER_ID(多区域用 SELLER_ID_NA / SELLER_ID_EU)。') +
      '(查看方式:Seller Central → 设置 → 账户信息 → 商户令牌 Merchant Token)',
    message: brokerMode
      ? 'Broker did not return sellerId for the selected store and region'
      : 'sellerId is required (flag --seller-id or env SELLER_ID / SELLER_ID_<REGION>)',
  });
}

const SELLER_ID_FLAG = {
  name: 'seller-id',
  desc: '卖家编号(本地模式可省略并读 SELLER_ID;Broker 模式仅用于与服务端返回值核对,不能兜底)',
};

const LISTINGS_INCLUDED_DATA = [
  'summaries',
  'attributes',
  'issues',
  'offers',
  'fulfillmentAvailability',
  'procurement',
  'relationships',
  'productTypes',
];

function validateListingsIncludedData(flags: Record<string, unknown>): void {
  const include = strFlag(flags, 'include');
  if (!include) return;
  for (const set of include.split(',').map((s) => s.trim())) {
    if (!LISTINGS_INCLUDED_DATA.includes(set)) {
      throw new AmzError({
        type: 'invalid_param', subtype: 'invalid_included_data', param: '--include', hintAgent: 'fix_param',
        hintHuman: `--include 里的 "${set}" 无效。可选:${LISTINGS_INCLUDED_DATA.join(' / ')}`,
        message: `invalid Listings includedData value: ${set}`,
      });
    }
  }
}

export const listingMine: ToolDefinition = {
  service: 'listing',
  command: 'mine',
  description: '列出自己店铺的 listing(可按状态/问题严重度过滤;这是私有数据,仅本店铺)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    SELLER_ID_FLAG,
    { name: 'skus', desc: '按 SKU 精确查,逗号分隔,最多 20 个(可选)' },
    {
      name: 'with-issue-severity',
      desc: '只看有问题的 listing,按严重度过滤(可选值:ERROR | WARNING)',
      enum: ['ERROR', 'WARNING'],
    },
    { name: 'page-size', desc: '每页数量,1-20,默认 10' },
    { name: 'page-token', desc: '分页游标' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'pageSize', '--page-size', { min: 1, max: 20, integer: true });
    const skus = strFlag(flags, 'skus')?.split(',').map((s) => s.trim()).filter(Boolean);
    if (skus && (skus.length < 1 || skus.length > 20)) {
      throw new AmzError({
        type: 'invalid_param', subtype: 'invalid_sku_count', param: '--skus', hintAgent: 'fix_param',
        hintHuman: '--skus 一次必须提供 1 到 20 个 SKU。', message: `--skus count must be 1-20, got ${skus.length}`,
      });
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const skus = strFlag(ctx.flags, 'skus');

    ctx.progress(`· 正在列出本店铺在 ${mkt.country} 的 listing...`);

    const resp = (await ctx.client.get(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
      {
        marketplaceIds: mkt.id,
        includedData: 'summaries,issues',
        ...(skus ? { identifiers: skus, identifiersType: 'SKU' } : {}),
        ...(strFlag(ctx.flags, 'withIssueSeverity')
          ? { withIssueSeverity: strFlag(ctx.flags, 'withIssueSeverity') }
          : {}),
        ...(strFlag(ctx.flags, 'pageSize') ? { pageSize: Number(strFlag(ctx.flags, 'pageSize')) } : {}),
        ...(strFlag(ctx.flags, 'pageToken') ? { pageToken: strFlag(ctx.flags, 'pageToken') } : {}),
      },
      mkt.region,
    )) as {
      numberOfResults?: number;
      pagination?: { nextToken?: string };
      items?: Array<Record<string, unknown>>;
    };

    return {
      marketplace: mkt.country,
      numberOfResults: resp.numberOfResults ?? 0,
      items: resp.items ?? [],
      ...(resp.pagination?.nextToken ? { nextToken: resp.pagination.nextToken } : {}),
    };
  },
};

export const listingSku: ToolDefinition = {
  service: 'listing',
  command: 'sku',
  description: '查自己店铺单个 SKU 的完整 listing 详情(属性/问题/报价/库存)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'sku', desc: '本店铺的 SKU(必填)', required: true },
    SELLER_ID_FLAG,
    {
      name: 'include',
      desc: '返回的数据集,默认 summaries,issues,offers,fulfillmentAvailability。可加 attributes/relationships/productTypes',
    },
  ],
  validate: (flags) => {
    validateListingsIncludedData(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const sku = strFlag(ctx.flags, 'sku')!;
    const include =
      strFlag(ctx.flags, 'include') ?? 'summaries,issues,offers,fulfillmentAvailability';

    ctx.progress(`· 正在查询 SKU "${sku}"(${mkt.country})...`);

    const item = (await ctx.client.get(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
      { marketplaceIds: mkt.id, includedData: include },
      mkt.region,
    )) as Record<string, unknown>;

    return { marketplace: mkt.country, item };
  },
};
