// listing search —— 在亚马逊商品目录中搜索(按关键词或 ASIN 批量查)
//
// API: Catalog Items API 2022-04-01 searchCatalogItems
//   GET /catalog/2022-04-01/items
// 参数与限制(2026-07-13 从官方 OpenAPI 规范核实):
//   keywords / identifiers 各最多 20 个;marketplaceIds 一次只能 1 个;
//   pageSize 默认 10、最大 20;identifiersType 枚举含 ASIN/EAN/UPC/SKU 等。
// 角色:Product Listing

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';

export const CATALOG_INCLUDED_DATA = [
  'attributes',
  'classifications',
  'dimensions',
  'identifiers',
  'images',
  'productTypes',
  'relationships',
  'salesRanks',
  'summaries',
  'vendorDetails',
];

export function validateCatalogIncludedData(flags: Record<string, unknown>): void {
  const include = strFlag(flags, 'include');
  if (!include) return;
  for (const set of include.split(',').map((s) => s.trim())) {
    if (!CATALOG_INCLUDED_DATA.includes(set)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_included_data',
        param: '--include',
        hintAgent: 'fix_param',
        hintHuman: `--include 里的 "${set}" 无效。可选:${CATALOG_INCLUDED_DATA.join(' / ')}`,
        message: `invalid includedData value: ${set}`,
      });
    }
  }
}

interface CatalogItem {
  asin?: string;
  summaries?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface SearchResponse {
  numberOfResults?: number;
  pagination?: { nextToken?: string; previousToken?: string };
  items?: CatalogItem[];
}

/** 精简输出:asin + 摊平的 summary + 额外请求的数据集原样保留。 */
export function simplifyItem(item: CatalogItem, extraSets: string[]): Record<string, unknown> {
  const summary = item.summaries?.[0] ?? {};
  const out: Record<string, unknown> = { asin: item.asin, ...summary };
  for (const set of extraSets) {
    if (set !== 'summaries' && item[set] !== undefined) out[set] = item[set];
  }
  return out;
}

export const listingSearch: ToolDefinition = {
  service: 'listing',
  command: 'search',
  description:
    '搜索亚马逊公开商品目录,任意商品含竞品(按关键词,或按 ASIN 批量查详情)。仅商品页公开信息,拿不到任何卖家的销量/库存等私有数据',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'keywords', desc: '搜索关键词,逗号分隔,最多 20 个(与 --asins 二选一)' },
    { name: 'asins', desc: 'ASIN 列表,逗号分隔,最多 20 个(与 --keywords 二选一)' },
    { name: 'brand', desc: '按品牌过滤(仅关键词搜索时有效)' },
    {
      name: 'include',
      desc: `额外返回的数据集,逗号分隔(默认 summaries)。可选:${CATALOG_INCLUDED_DATA.join(',')}`,
    },
    { name: 'page-size', desc: '每页数量,1-20,默认 10' },
    { name: 'page-token', desc: '分页游标(上一页返回的 nextToken)' },
  ],
  validate: (flags) => {
    const keywords = strFlag(flags, 'keywords');
    const asins = strFlag(flags, 'asins');
    if (!keywords && !asins) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'missing_search_input',
        param: '--keywords',
        hintAgent: 'fix_param',
        hintHuman: '请提供 --keywords(关键词搜索)或 --asins(按 ASIN 查)其中之一。',
        message: 'either --keywords or --asins is required',
      });
    }
    if (keywords && asins) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'conflicting_search_input',
        param: '--asins',
        hintAgent: 'fix_param',
        hintHuman: '--keywords 和 --asins 不能同时使用,请二选一。',
        message: '--keywords and --asins are mutually exclusive',
      });
    }
    const values = (keywords ?? asins ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (values.length < 1 || values.length > 20) {
      throw new AmzError({
        type: 'invalid_param', subtype: 'invalid_search_item_count',
        param: keywords ? '--keywords' : '--asins', hintAgent: 'fix_param',
        hintHuman: '搜索值一次必须提供 1 到 20 个（逗号分隔）。',
        message: `catalog search list must contain 1-20 values, got ${values.length}`,
      });
    }
    const pageSize = strFlag(flags, 'pageSize');
    if (pageSize !== undefined) {
      const n = Number(pageSize);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'invalid_page_size',
          param: '--page-size',
          hintAgent: 'fix_param',
          hintHuman: '--page-size 必须是 1 到 20 之间的整数(亚马逊接口上限 20)。',
          message: `--page-size must be an integer in [1,20], got: ${pageSize}`,
        });
      }
    }
    validateCatalogIncludedData(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const keywords = strFlag(ctx.flags, 'keywords');
    const asins = strFlag(ctx.flags, 'asins');
    const include = strFlag(ctx.flags, 'include') ?? 'summaries';
    const extraSets = include.split(',').map((s) => s.trim());

    ctx.progress(`· 正在 ${mkt.name}(${mkt.country})搜索商品目录...`);

    const resp = (await ctx.client.get('/catalog/2022-04-01/items', {
      marketplaceIds: mkt.id,
      includedData: include,
      ...(keywords ? { keywords } : {}),
      ...(asins ? { identifiers: asins, identifiersType: 'ASIN' } : {}),
      ...(strFlag(ctx.flags, 'brand') ? { brandNames: strFlag(ctx.flags, 'brand') } : {}),
      ...(strFlag(ctx.flags, 'pageSize') ? { pageSize: Number(strFlag(ctx.flags, 'pageSize')) } : {}),
      ...(strFlag(ctx.flags, 'pageToken') ? { pageToken: strFlag(ctx.flags, 'pageToken') } : {}),
    }, mkt.region)) as SearchResponse;

    const items = (resp.items ?? []).map((item) => simplifyItem(item, extraSets));
    return {
      marketplace: mkt.country,
      numberOfResults: resp.numberOfResults ?? items.length,
      items,
      ...(resp.pagination?.nextToken ? { nextToken: resp.pagination.nextToken } : {}),
    };
  },
};
