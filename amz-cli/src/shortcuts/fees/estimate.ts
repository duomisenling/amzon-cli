// fees estimate —— 费用预估:按这个价卖,亚马逊要抽多少?
//
// API: Product Fees API v0(2026-07-14 官方 OpenAPI 核实)
//   POST /products/fees/v0/items/{Asin}/feesEstimate            按 ASIN
//   POST /products/fees/v0/listings/{SellerSKU}/feesEstimate    按 SKU
//   body.FeesEstimateRequest 必填:MarketplaceId / PriceToEstimateFees.ListingPrice / Identifier
//   响应:FeesEstimateResult{Status, FeesEstimate:{TotalFeesEstimate, FeeDetailList[]}}
//   费用明细原样透传(FeeType 枚举官方未列全,不做本地翻译猜测)
// 角色:Pricing

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';

interface FeeDetail {
  FeeType?: string;
  FinalFee?: { CurrencyCode?: string; Amount?: number };
}
interface FeesEstimateResponse {
  payload?: {
    FeesEstimateResult?: {
      Status?: string;
      FeesEstimate?: {
        TotalFeesEstimate?: { CurrencyCode?: string; Amount?: number };
        FeeDetailList?: FeeDetail[];
      };
      Error?: unknown;
    };
  };
}

export const feesEstimate: ToolDefinition = {
  service: 'fees',
  command: 'estimate',
  description: '预估费用:按某个价格卖,亚马逊抽多少(佣金+FBA 配送费),算毛利用',
  mutation: 'none',
  roles: ['Pricing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'price', desc: '拟售价,数字(必填)', required: true },
    { name: 'asin', desc: '按 ASIN 估(与 --sku 二选一)' },
    { name: 'sku', desc: '按自己店铺 SKU 估(与 --asin 二选一)' },
    { name: 'fbm', type: 'boolean', desc: '按自发货估算(默认按 FBA)' },
  ],
  validate: (flags) => {
    const asin = strFlag(flags, 'asin');
    const sku = strFlag(flags, 'sku');
    if ((!asin && !sku) || (asin && sku)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'missing_product_identifier',
        param: '--asin',
        hintAgent: 'fix_param',
        hintHuman: '请提供 --asin 或 --sku 其中一个(不能同时)。',
        message: 'exactly one of --asin / --sku is required',
      });
    }
    const price = Number(strFlag(flags, 'price'));
    if (!Number.isFinite(price) || price <= 0) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_price',
        param: '--price',
        hintAgent: 'fix_param',
        hintHuman: '--price 必须是大于 0 的数字。',
        message: `--price must be a positive number, got: ${strFlag(flags, 'price')}`,
      });
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const asin = strFlag(ctx.flags, 'asin');
    const sku = strFlag(ctx.flags, 'sku');
    const price = Number(strFlag(ctx.flags, 'price'));
    const currency = mkt.currency;
    const isFba = !ctx.flags['fbm'];

    const path = asin
      ? `/products/fees/v0/items/${encodeURIComponent(asin.toUpperCase())}/feesEstimate`
      : `/products/fees/v0/listings/${encodeURIComponent(sku!)}/feesEstimate`;

    ctx.progress(`· 正在预估 ${asin ?? sku} 按 ${price} ${currency} 销售的费用(${isFba ? 'FBA' : '自发货'})...`);

    const resp = (await ctx.client.request('POST', path, {
      retry5xx: true,
      body: {
        FeesEstimateRequest: {
          MarketplaceId: mkt.id,
          IsAmazonFulfilled: isFba,
          PriceToEstimateFees: {
            ListingPrice: { CurrencyCode: currency, Amount: price },
          },
          Identifier: `amz-cli-${Date.now()}`,
        },
      },
      region: mkt.region,
    })) as FeesEstimateResponse;

    const result = resp.payload?.FeesEstimateResult;
    if (result?.Status !== 'Success') {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'fees.estimate_failed',
        hintAgent: 'report_to_human',
        hintHuman: `费用预估失败(状态 ${result?.Status ?? '未知'})。常见原因:该 ASIN/SKU 在此市场不存在或无权限。原始响应见 message。`,
        message: `fees estimate status=${result?.Status}: ${JSON.stringify(result?.Error ?? {}).slice(0, 500)}`,
      });
    }

    const total = result.FeesEstimate?.TotalFeesEstimate;
    const totalAmount = total?.Amount ?? 0;
    const fees = (result.FeesEstimate?.FeeDetailList ?? []).map((f) => ({
      type: f.FeeType,
      amount: f.FinalFee ? `${f.FinalFee.Amount} ${f.FinalFee.CurrencyCode}` : '-',
    }));

    return {
      marketplace: mkt.country,
      product: asin ?? sku,
      listingPrice: `${price} ${currency}`,
      fulfillment: isFba ? 'FBA' : 'FBM(自发货)',
      totalFees: total ? `${totalAmount} ${total.CurrencyCode}` : '-',
      // 直观的到手估算:售价 - 亚马逊费用(不含货物成本/头程)
      netBeforeCost: `${(price - totalAmount).toFixed(2)} ${currency}`,
      feeDetails: fees,
    };
  },
};
