// catalog batch —— 批量按 ASIN 拉商品目录数据(图片/变体/摘要等),用于粗筛盘点
//
// API: Catalog Items 2022-04-01 searchCatalogItems(与 listing search 同一接口)
//   GET /catalog/2022-04-01/items;identifiers 一次最多 20 个 ASIN,marketplaceIds 1 个。
//   本命令在既有 listing search 之上加:文件输入 + 自动分片(>20) + 查不到也输出 found:false。
//
// 关键(任务书要求):
//   - 一次最多 20 个 ASIN,batch 自动分片,片间遵守限速(客户端全局限速器已管)。
//   - 每个输入 ASIN 输出一条记录;查不到的输出 { asin, found:false }——
//     "查不到"和"不合格"是两件事,下游做差集要区分。
//   - --include(includedData)做成参数,不写死。
// 角色:Product Listing

import { readFileSync, writeFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';
import {
  CATALOG_INCLUDED_DATA,
  simplifyItem,
  validateCatalogIncludedData,
} from '../listing/catalog-search.js';

export const CATALOG_BATCH_SIZE = 20;

interface CatalogItem {
  asin?: string;
  summaries?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** 把逗号/换行/空格分隔的原始文本解析成去重后的 ASIN 列表(保持首次出现顺序)。 */
export function parseAsinList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const asin = token.trim();
    if (asin && !seen.has(asin)) {
      seen.add(asin);
      out.push(asin);
    }
  }
  return out;
}

/** ASIN 格式校验:10 位字母或数字。Catalog API 对格式非法的标识符会 400 拒整批,
 *  所以格式非法的先挡在客户端,不发给 API(它们会被记为 found:false)。 */
export function isValidAsinFormat(asin: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(asin);
}

/** 把列表切成每片最多 size 个。 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 纯逻辑:按"请求的 ASIN 顺序"合并结果,查到的用 simplifyItem 摊平并标 found:true,
 * 查不到的输出 { asin, found:false }。便于单测。
 */
export function buildBatchRecords(
  requestedAsins: string[],
  foundItems: CatalogItem[],
  extraSets: string[],
): Array<Record<string, unknown>> {
  const byAsin = new Map<string, CatalogItem>();
  for (const item of foundItems) {
    if (item.asin) byAsin.set(item.asin, item);
  }
  return requestedAsins.map((asin) => {
    const item = byAsin.get(asin);
    if (!item) return { asin, found: false };
    return { found: true, ...simplifyItem(item, extraSets) };
  });
}

async function fetchShard(
  ctx: ToolContext,
  marketplaceId: string,
  region: ReturnType<typeof resolveMarketplace>['region'],
  asins: string[],
  include: string,
): Promise<CatalogItem[]> {
  const resp = (await ctx.client.get(
    '/catalog/2022-04-01/items',
    {
      marketplaceIds: marketplaceId,
      identifiers: asins.join(','),
      identifiersType: 'ASIN',
      includedData: include,
    },
    region,
  )) as { items?: CatalogItem[] };
  return resp.items ?? [];
}

export const catalogBatch: ToolDefinition = {
  service: 'catalog',
  command: 'batch',
  description:
    '批量按 ASIN 拉商品目录数据(自动分片,每片 20 个),查不到的也输出 found:false;--include 选数据集',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 UK / DE / US(必填)', required: true },
    { name: 'asin-file', desc: 'ASIN 列表文件路径(每行一个,或逗号/空格分隔;与 --asins 二选一)' },
    { name: 'asins', desc: 'ASIN 列表,逗号分隔(与 --asin-file 二选一)' },
    {
      name: 'include',
      desc: `额外返回的数据集,逗号分隔(默认 images,summaries)。可选:${CATALOG_INCLUDED_DATA.join(',')}`,
    },
    { name: 'out', desc: '把结果写到该文件路径(可选;上千条建议用)' },
  ],
  validate: (flags) => {
    const file = strFlag(flags, 'asinFile');
    const asins = strFlag(flags, 'asins');
    if (!file && !asins) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'missing_asin_input',
        param: '--asin-file',
        hintAgent: 'fix_param',
        hintHuman: '请提供 --asin-file(ASIN 文件)或 --asins(逗号分隔)其中之一。',
        message: 'either --asin-file or --asins is required',
      });
    }
    validateCatalogIncludedData(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const include = strFlag(ctx.flags, 'include') ?? 'images,summaries';
    const extraSets = include.split(',').map((s) => s.trim());

    const file = strFlag(ctx.flags, 'asinFile');
    let raw: string;
    if (file) {
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'asin_file_unreadable',
          param: '--asin-file',
          hintAgent: 'fix_param',
          hintHuman: `读不到 ASIN 文件:${file}。请检查路径是否正确。`,
          message: `cannot read --asin-file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      raw = strFlag(ctx.flags, 'asins') ?? '';
    }
    const asins = parseAsinList(raw);
    if (asins.length === 0) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'empty_asin_list',
        param: '--asin-file',
        hintAgent: 'fix_param',
        hintHuman: 'ASIN 列表为空,请检查文件内容或 --asins 参数。',
        message: 'parsed ASIN list is empty',
      });
    }

    // 只把格式合法的 ASIN 发给 API(格式非法的会被 buildBatchRecords 记为 found:false)
    const validForApi = asins.filter(isValidAsinFormat);
    const malformed = asins.length - validForApi.length;
    if (malformed > 0) {
      ctx.progress(`· 跳过 ${malformed} 个格式非法的 ASIN(非 10 位字母数字),它们会记为 found:false`);
    }
    const shards = chunk(validForApi, CATALOG_BATCH_SIZE);
    const found: CatalogItem[] = [];
    for (let i = 0; i < shards.length; i++) {
      ctx.progress(`· 正在拉取商品目录(第 ${i + 1}/${shards.length} 片,${shards[i]!.length} 个 ASIN)...`);
      found.push(...(await fetchShard(ctx, mkt.id, mkt.region, shards[i]!, include)));
    }

    const items = buildBatchRecords(asins, found, extraSets);
    const notFound = items.filter((r) => r['found'] === false).length;
    const data = {
      marketplace: mkt.country,
      requested: asins.length,
      found: asins.length - notFound,
      notFound,
      items,
    };
    const out = strFlag(ctx.flags, 'out');
    if (out) {
      writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8');
      return { savedTo: out, requested: asins.length, found: asins.length - notFound, notFound };
    }
    return data;
  },
};
