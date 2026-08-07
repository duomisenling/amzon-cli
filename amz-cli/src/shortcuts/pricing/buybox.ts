// pricing buybox —— 批量看"自己的 listing 有没有拿到 Buy Box"
//
// 背景:运营高频要问"我哪些 listing 丢了 Buy Box"。现状要逐个 ASIN 查 competitive 再自己比对。
//   这里收成一条命令:拿自己的 ASIN 批量查 competitiveSummary(featuredBuyingOptions)→
//   看 Buy Box(featured offer)是不是自己的 sellerId 拿着 → 标 won/lost/no-featured-offer。
//   一次最多 20 个/批,超过自动分批;结果带价格,便于接批量改价。
//
// API: Product Pricing 2022-05-01 getCompetitiveSummary(见 pricing/competitive.ts 已核实用法)
//   POST /batches/products/pricing/2022-05-01/items/competitiveSummary
//   featuredBuyingOptions[].segmentedFeaturedOffers[] 是各买家段的 featured(Buy Box)报价,
//   带 sellerId 与 listingPrice(结构待真机确认,见下)。

import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';
import { resolveSellerId } from '../listing/mine.js';
import { mapBatchResults, type BatchResponse } from './batch.js';

const COMPETITIVE_URI = '/products/pricing/2022-05-01/items/competitiveSummary';
const BATCH_MAX = 20;

export type BuyBoxStatus = 'won' | 'lost' | 'undetermined' | 'no-featured-offer' | 'error';

export interface BuyBoxRow {
  asin: string;
  status: BuyBoxStatus;
  /** 是否存在 featured(Buy Box)报价 */
  hasFeaturedOffer: boolean;
  /** Buy Box 是否自己拿着;无法判定(响应未含 sellerId)时为 null */
  iWin: boolean | null;
  /** Buy Box 价格(featured offer 的挂牌价) */
  buyBoxPrice?: number;
  currency?: string;
  /** 该 ASIN 查询失败时的错误信息 */
  error?: unknown;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/**
 * 纯函数:从单个 ASIN 的 competitiveSummary body 判定 Buy Box 归属。
 * 只认 buyingOptionType==='New' 的 featured 报价;比对 mySellerId 判 won/lost;
 * 响应未暴露 sellerId 时判 undetermined(无法判定归属,不能当 lost)。
 * 结构对字段名容错(price 支持 listingPrice.amount / price.amount)。
 */
export function extractBuyBox(
  summaryBody: Record<string, unknown> | undefined,
  mySellerId: string,
): Omit<BuyBoxRow, 'asin'> {
  const options = asArray(summaryBody?.['featuredBuyingOptions']);
  // 优先 New;拿不到 buyingOptionType 就全收
  const relevant = options.filter((o) => {
    const t = String(o['buyingOptionType'] ?? '').toLowerCase();
    return t === '' || t === 'new';
  });
  const featured: Array<Record<string, unknown>> = [];
  for (const opt of relevant) featured.push(...asArray(opt['segmentedFeaturedOffers']));

  if (featured.length === 0) {
    return { status: 'no-featured-offer', hasFeaturedOffer: false, iWin: false };
  }

  let sawSellerId = false;
  let iWin = false;
  let buyBoxPrice: number | undefined;
  let currency: string | undefined;
  let myPrice: number | undefined;
  for (const offer of featured) {
    const sellerId = offer['sellerId'] != null ? String(offer['sellerId']) : undefined;
    if (sellerId) sawSellerId = true;
    const priceObj = (offer['listingPrice'] ?? offer['price']) as Record<string, unknown> | undefined;
    const amount = num(priceObj?.['amount']);
    const cur = priceObj?.['currencyCode'] != null ? String(priceObj['currencyCode']) : undefined;
    if (buyBoxPrice === undefined && amount !== undefined) {
      buyBoxPrice = amount;
      currency = cur;
    }
    if (sellerId && sellerId === mySellerId) {
      iWin = true;
      if (amount !== undefined) myPrice = amount;
    }
  }
  // 若能认出自己中标,用自己的价作 Buy Box 价更准
  if (myPrice !== undefined) buyBoxPrice = myPrice;

  // 响应未暴露 sellerId 时无法判定归属 → undetermined,不能硬标 lost
  // (误标 lost 可能触发下游错误降价;undetermined 需要人工/其他渠道再确认)
  return {
    status: !sawSellerId ? 'undetermined' : iWin ? 'won' : 'lost',
    hasFeaturedOffer: true,
    iWin: sawSellerId ? iWin : null,
    ...(buyBoxPrice !== undefined ? { buyBoxPrice } : {}),
    ...(currency ? { currency } : {}),
  };
}

/** 把一批 competitiveSummary 结果(mapBatchResults 产物)压成 Buy Box 行。 */
export function summarizeBuyBox(
  results: Array<Record<string, unknown>>,
  mySellerId: string,
): BuyBoxRow[] {
  return results.map((r) => {
    const asin = String(r['asin']);
    // 非 200,或 200 但被标识核对判为错误行(mapBatchResults 的 mismatch)→ 都算 error
    if (r['httpStatus'] !== 200 || r['error'] !== undefined) {
      return { asin, status: 'error', hasFeaturedOffer: false, iWin: null, error: r['error'] };
    }
    return { asin, ...extractBuyBox(r['summary'] as Record<string, unknown> | undefined, mySellerId) };
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function readAsins(flags: Record<string, unknown>): string[] {
  const file = strFlag(flags, 'asinFile');
  const inline = strFlag(flags, 'asins');
  let raw: string[];
  if (file) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new AmzError({
        type: 'invalid_param', subtype: 'buybox.file_unreadable', param: '--asin-file', hintAgent: 'fix_param',
        hintHuman: `读不到 ASIN 文件:${file}`, message: `cannot read --asin-file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    raw = text.split(/\r?\n/);
  } else {
    raw = (inline ?? '').split(',');
  }
  const asins = [...new Set(raw.map((a) => a.trim().toUpperCase()).filter(Boolean))];
  if (asins.length === 0) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'buybox.no_asins', param: '--asins', hintAgent: 'fix_param',
      hintHuman: '缺少 ASIN:用 --asins A,B,C 或 --asin-file <每行一个>。', message: 'no ASINs provided',
    });
  }
  const bad = asins.find((a) => !/^[A-Z0-9]{10}$/.test(a));
  if (bad) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'buybox.invalid_asin', param: '--asins', hintAgent: 'fix_param',
      hintHuman: `ASIN 必须是 10 位字母数字(收到 "${bad}")。`, message: `invalid ASIN: ${bad}`,
    });
  }
  return asins;
}

export const pricingBuybox: ToolDefinition = {
  service: 'pricing',
  command: 'buybox',
  description:
    '批量看自己的 listing 有没有拿到 Buy Box:按 ASIN 查 featured offer 并比对自己的 sellerId,' +
    '标 won/lost/undetermined(响应未暴露 sellerId,无法判定归属)/no-featured-offer,带 Buy Box 价格。' +
    '一次最多 20/批,超过自动分批',
  mutation: 'none',
  isAsync: true,
  roles: ['Pricing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'asins', desc: '自己的 ASIN 列表,逗号分隔(与 --asin-file 二选一)' },
    { name: 'asin-file', desc: 'ASIN 文件,每行一个(与 --asins 二选一,适合大批量)' },
    { name: 'seller-id', desc: '自己的卖家编号(本地模式可省并读 SELLER_ID);判定 Buy Box 归属用' },
    {
      name: 'lost-only',
      desc: '只返回确认丢失 Buy Box 的(lost / no-featured-offer;不含 undetermined——归属未判定不能当丢失处理)',
      type: 'boolean',
    },
    { name: 'out', desc: '把完整结果写到该 JSON 文件,stdout 只回汇总' },
  ],
  validate: (flags) => {
    readAsins(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const asins = readAsins(ctx.flags);
    const lostOnly = ctx.flags['lostOnly'] === true;

    const rows: BuyBoxRow[] = [];
    const batches = chunk(asins, BATCH_MAX);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      ctx.progress(`· 正在查第 ${i + 1}/${batches.length} 批 Buy Box(${batch.length} 个 ASIN)...`);
      const resp = (await ctx.client.request(
        'POST',
        '/batches/products/pricing/2022-05-01/items/competitiveSummary',
        {
          retry5xx: true,
          body: {
            requests: batch.map((asin) => ({
              asin,
              marketplaceId: mkt.id,
              includedData: ['featuredBuyingOptions'],
              method: 'GET',
              uri: COMPETITIVE_URI,
            })),
          },
          region: mkt.region,
        },
      )) as BatchResponse;
      const mapped = mapBatchResults(resp, batch, 'asin', 'summary');
      rows.push(...summarizeBuyBox(mapped, sellerId));
    }

    const shown = lostOnly ? rows.filter((r) => r.status === 'lost' || r.status === 'no-featured-offer') : rows;
    // 各状态互斥:won + lost + undetermined + noFeaturedOffer + errors === total
    const counts = {
      total: rows.length,
      won: rows.filter((r) => r.status === 'won').length,
      lost: rows.filter((r) => r.status === 'lost').length,
      undetermined: rows.filter((r) => r.status === 'undetermined').length,
      noFeaturedOffer: rows.filter((r) => r.status === 'no-featured-offer').length,
      errors: rows.filter((r) => r.status === 'error').length,
    };
    const base = { marketplace: mkt.country, counts };

    const out = strFlag(ctx.flags, 'out');
    if (out) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, JSON.stringify({ ...base, rows: shown }, null, 2), 'utf8');
      return { ...base, out, note: `完整 ${shown.length} 行已写入 ${out}` };
    }
    return { ...base, count: shown.length, rows: shown };
  },
};
