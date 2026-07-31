// ads product-ads / coverage —— SP(商品推广)投放标的盘点(只读)
//
// API(与本仓库既有 ads campaigns 完全同款的 v3 list 模式):
//   POST /sp/productAds/list
//     Content-Type/Accept: application/vnd.spProductAd.v3+json(已在 ADS_CONTENT_TYPES 定义)
//     body: { maxResults, nextToken?, stateFilter?: { include: [...] } }
//     响应: { productAds: [...], nextToken }
//   官方 v3 文档需登录访问;端点/内容类型/分页沿用仓库内已验证的 spCampaign 同款约定,
//   productAd 对象字段(adId/adGroupId/campaignId/asin/sku/state)原样透传,不猜测。
//
// 用途:拿"哪些 ASIN/SKU 正在被投放",供下游做"建了活动但零曝光"等盘点。
// 凭证:走 AdsClient(ADS_* 独立凭证 + profileId 定位主体×站点),与 SP-API 无关。

import { writeFileSync } from 'node:fs';
import { ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion, requireProfileId } from './common.js';

type ProductAd = Record<string, unknown>;

export interface AdCoverageRow {
  asin?: string;
  sku?: string;
  adId?: string;
  adGroupId?: string;
  campaignId?: string;
  state?: string;
}

/** 纯逻辑:从 productAds 原始对象抽取盘点字段,并按可接受状态过滤(便于单测)。 */
export function extractAdCoverage(productAds: ProductAd[], acceptedStates: string[]): AdCoverageRow[] {
  const accepted = new Set(acceptedStates.map((s) => s.trim().toUpperCase()).filter(Boolean));
  const rows: AdCoverageRow[] = [];
  for (const ad of productAds) {
    const state = ad['state'] != null ? String(ad['state']) : undefined;
    if (accepted.size > 0 && (!state || !accepted.has(state.toUpperCase()))) continue;
    rows.push({
      asin: ad['asin'] != null ? String(ad['asin']) : undefined,
      sku: ad['sku'] != null ? String(ad['sku']) : undefined,
      adId: ad['adId'] != null ? String(ad['adId']) : undefined,
      adGroupId: ad['adGroupId'] != null ? String(ad['adGroupId']) : undefined,
      campaignId: ad['campaignId'] != null ? String(ad['campaignId']) : undefined,
      state,
    });
  }
  return rows;
}

/** 翻完所有页,拿到该 profile 下全部 productAds(可选按状态服务端过滤)。 */
async function fetchAllProductAds(
  ctx: ToolContext,
  profileId: string,
  region: ReturnType<typeof adsRegion>,
  states: string[],
): Promise<ProductAd[]> {
  const all: ProductAd[] = [];
  let nextToken: string | undefined;
  let page = 0;
  do {
    page += 1;
    ctx.progress(`· 正在拉取 profile ${profileId} 的投放商品(第 ${page} 页)...`);
    const resp = (await ctx.adsClient.request('POST', '/sp/productAds/list', {
      profileId,
      region,
      contentType: ADS_CONTENT_TYPES.spProductAd,
      retry5xx: true,
      body: {
        maxResults: 100,
        ...(nextToken ? { nextToken } : {}),
        ...(states.length ? { stateFilter: { include: states } } : {}),
      },
    })) as { productAds?: ProductAd[]; nextToken?: string } | null;
    all.push(...(resp?.productAds ?? []));
    nextToken = resp?.nextToken;
  } while (nextToken);
  return all;
}

function deliver(out: string | undefined, data: Record<string, unknown>): Record<string, unknown> {
  if (out) {
    writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { savedTo: out, count: (data['count'] as number) ?? undefined };
  }
  return data;
}

/** 解析可接受状态列表;空/未给时用默认。 */
function parseStates(raw: string | undefined, fallback: string[]): string[] {
  if (!raw?.trim()) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const adsProductAds: ToolDefinition = {
  service: 'ads',
  command: 'product-ads',
  description: '列出 SP 广告下全部投放商品(productAds,自动翻页,原样透传;可 --state 过滤)',
  mutation: 'none',
  isAsync: false,
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    { name: 'state', desc: '按状态过滤,逗号分隔(如 ENABLED,PAUSED;默认不过滤,全拉)' },
    { name: 'out', desc: '把结果写到该文件路径(可选)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const states = parseStates(strFlag(ctx.flags, 'state'), []);
    const productAds = await fetchAllProductAds(ctx, profileId, adsRegion(ctx.flags), states);
    return deliver(strFlag(ctx.flags, 'out'), {
      profileId,
      ...(states.length ? { stateFilter: states } : {}),
      count: productAds.length,
      productAds,
    });
  },
};

export const adsCoverage: ToolDefinition = {
  service: 'ads',
  command: 'coverage',
  description:
    '盘点该 profile 下"正在投放的 ASIN/SKU":每条 {asin,sku,adGroupId,campaignId,state}(默认排除 ARCHIVED)',
  mutation: 'none',
  isAsync: false,
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    { name: 'state', desc: '算作"在投放"的可接受状态,逗号分隔,默认 ENABLED,PAUSED(即排除 ARCHIVED)' },
    { name: 'out', desc: '把结果写到该文件路径(可选)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const acceptedStates = parseStates(strFlag(ctx.flags, 'state'), ['ENABLED', 'PAUSED']);
    const productAds = await fetchAllProductAds(ctx, profileId, adsRegion(ctx.flags), acceptedStates);
    const rows = extractAdCoverage(productAds, acceptedStates);
    return deliver(strFlag(ctx.flags, 'out'), {
      profileId,
      acceptedStates,
      count: rows.length,
      items: rows,
    });
  },
};
