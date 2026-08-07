// aplus —— A+ Content API 2020-11-01(只读:盘点"哪些 ASIN 有已发布 A+ 内容")
//
// API(2026-07-28 从官方模型 amzn/selling-partner-api-models aplusContent_2020-11-01 核实):
//   GET /aplus/2020-11-01/contentDocuments
//       必填 marketplaceId;可选 pageToken;响应 contentMetadataRecords[] + nextPageToken
//   GET /aplus/2020-11-01/contentDocuments/{contentReferenceKey}/asins
//       必填 marketplaceId;可选 pageToken/asinSet(过滤)/includedDataSet;
//       响应 asinMetadataSet[](每项含 asin/title/...) + nextPageToken —— 注意不是 asinSet
//   GET /aplus/2020-11-01/contentDocuments/{contentReferenceKey}
//       必填 marketplaceId;includedDataSet=CONTENTS,METADATA 才返回内容本体;
//       响应 contentRecord{contentReferenceKey,contentMetadata,contentDocument}。
//       注意:contentDocument 模块里的图片是内部引用(uploadDestinationId)+altText,
//       **不含公开图片 URL**——这是 API 本身的限制,不是实现缺漏。
//   ContentStatus 枚举:APPROVED / DRAFT / REJECTED / SUBMITTED
//     —— 注意:官方无 "PUBLISHED",判定"有 A+"用 APPROVED(见 coverage 默认)。
//   限制:本 API 不覆盖 Premium A+(高级 A+)。
// 角色:Product Listing
//
// 输出沿用全 CLI 的 {ok:true,data} 信封约定;大结果集可用 --out 写文件。

import { writeFileSync } from 'node:fs';
import type { MarketplaceInfo } from '../../internal/client/regions.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { assertPageWithinLimit, resolveMarketplace, strFlag } from '../common.js';

interface ContentMetadataRecord {
  contentReferenceKey?: string;
  contentMetadata?: {
    name?: string;
    marketplaceId?: string;
    status?: string;
    badgeSet?: string[];
    updateTime?: string;
  };
}

export interface AplusDocument {
  contentReferenceKey?: string;
  name?: string;
  status?: string;
  badgeSet?: string[];
  updateTime?: string;
}

export interface AplusCoverageRow {
  asin: string;
  contentReferenceKey?: string;
  status?: string;
}

/** 默认"有 A+"判定的可接受状态(官方枚举里表示已批准/已发布的只有 APPROVED)。 */
export const DEFAULT_APLUS_ACCEPTED_STATUS = ['APPROVED'];

/**
 * 纯逻辑:把 A+ 文档 + 每个文档的 ASIN 列表,展平成 coverage 行,只保留可接受状态的文档。
 * 便于单测;不做去重(一个 ASIN 可能关联多个已批准文档,交给下游判定)。
 */
export function buildAplusCoverage(
  documents: AplusDocument[],
  asinsByKey: Record<string, string[]>,
  acceptedStatuses: string[],
): AplusCoverageRow[] {
  const accepted = new Set(acceptedStatuses.map((s) => s.trim().toUpperCase()).filter(Boolean));
  const rows: AplusCoverageRow[] = [];
  for (const doc of documents) {
    if (!doc.status || !accepted.has(doc.status.toUpperCase())) continue;
    const key = doc.contentReferenceKey;
    if (!key) continue;
    for (const asin of asinsByKey[key] ?? []) {
      rows.push({ asin, contentReferenceKey: key, status: doc.status });
    }
  }
  return rows;
}

/** 翻完所有页,拿到该站点全部 A+ 文档元数据。 */
async function fetchAllDocuments(ctx: ToolContext, mkt: MarketplaceInfo): Promise<AplusDocument[]> {
  const docs: AplusDocument[] = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    page += 1;
    // 翻页熔断:防上游 pageToken 异常导致无限翻页
    assertPageWithinLimit(page, 'aplus.pagination_overflow', 'A+ 内容文档');
    ctx.progress(`· 正在拉取 ${mkt.country} 的 A+ 内容文档(第 ${page} 页)...`);
    const resp = (await ctx.client.get(
      '/aplus/2020-11-01/contentDocuments',
      { marketplaceId: mkt.id, ...(pageToken ? { pageToken } : {}) },
      mkt.region,
    )) as { contentMetadataRecords?: ContentMetadataRecord[]; nextPageToken?: string };
    for (const r of resp.contentMetadataRecords ?? []) {
      docs.push({
        contentReferenceKey: r.contentReferenceKey,
        name: r.contentMetadata?.name,
        status: r.contentMetadata?.status,
        badgeSet: r.contentMetadata?.badgeSet,
        updateTime: r.contentMetadata?.updateTime,
      });
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return docs;
}

/** 翻完所有页,拿到某个 A+ 文档关联的全部 ASIN。 */
async function fetchAsinsForKey(
  ctx: ToolContext,
  mkt: MarketplaceInfo,
  contentReferenceKey: string,
): Promise<string[]> {
  const asins: string[] = [];
  let pageToken: string | undefined;
  let page = 0;
  do {
    page += 1;
    // 翻页熔断:防上游 pageToken 异常导致无限翻页
    assertPageWithinLimit(page, 'aplus.pagination_overflow', 'A+ 文档关联 ASIN');
    // 响应字段是 asinMetadataSet(对象数组,每个含 asin/title/... );asinSet 只是请求过滤参数。
    const resp = (await ctx.client.get(
      `/aplus/2020-11-01/contentDocuments/${encodeURIComponent(contentReferenceKey)}/asins`,
      { marketplaceId: mkt.id, ...(pageToken ? { pageToken } : {}) },
      mkt.region,
    )) as { asinMetadataSet?: Array<{ asin?: string }>; nextPageToken?: string };
    for (const m of resp.asinMetadataSet ?? []) {
      if (m.asin) asins.push(m.asin);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return asins;
}

export interface AplusModuleSummary {
  type?: string;
  /** 模块内全部文案(标题/正文等 TextComponent 的 value,按出现顺序) */
  texts: string[];
  /** 模块内图片的替代文本(图片本体只有内部引用 ID,API 不给公开 URL) */
  imageAltTexts: string[];
}

/**
 * 纯逻辑:把 A+ 模块列表压成"类型 + 文案 + 图片替代文本"的摘要,便于人读和单测。
 * 模块结构按类型各不相同(几十种),不逐一建模:递归收集 TextComponent 的 value
 * 和 ImageComponent 的 altText —— 这两个字段名在官方模型里是稳定的。
 */
export function summarizeAplusModules(modules: unknown[]): AplusModuleSummary[] {
  return modules.map((module) => {
    const texts: string[] = [];
    const imageAltTexts: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const rec = node as Record<string, unknown>;
      // TextComponent:{ value, decoratorSet };图片的 altText 是普通字符串字段
      if (typeof rec['value'] === 'string' && rec['value'].trim()) texts.push(rec['value']);
      if (typeof rec['altText'] === 'string' && rec['altText'].trim()) {
        imageAltTexts.push(rec['altText']);
      }
      for (const v of Object.values(rec)) walk(v);
    };
    walk(module);
    const type =
      typeof (module as Record<string, unknown> | null)?.['contentModuleType'] === 'string'
        ? ((module as Record<string, unknown>)['contentModuleType'] as string)
        : undefined;
    return { type, texts, imageAltTexts };
  });
}

/** --out 写文件的统一处理:给了路径就写文件返回摘要,否则原样返回。 */
function deliver(out: string | undefined, data: Record<string, unknown>): Record<string, unknown> {
  if (out) {
    writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { savedTo: out, count: (data['count'] as number) ?? undefined };
  }
  return data;
}

export const aplusDocuments: ToolDefinition = {
  service: 'aplus',
  command: 'documents',
  description: '列出该站点全部 A+ 内容文档元数据(contentReferenceKey/状态/名称,自动翻页;不含高级 A+)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 UK / DE / US(必填)', required: true },
    { name: 'out', desc: '把结果写到该文件路径(可选;不给则输出到 stdout)' },
  ],
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const documents = await fetchAllDocuments(ctx, mkt);
    return deliver(strFlag(ctx.flags, 'out'), {
      marketplace: mkt.country,
      count: documents.length,
      documents,
    });
  },
};

export const aplusAsins: ToolDefinition = {
  service: 'aplus',
  command: 'asins',
  description: '列出某个 A+ 文档(--content-key)关联的全部 ASIN(自动翻页)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 UK / DE / US(必填)', required: true },
    { name: 'content-key', desc: 'A+ 文档的 contentReferenceKey(必填,aplus documents 可查)', required: true },
    { name: 'out', desc: '把结果写到该文件路径(可选)' },
  ],
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const key = strFlag(ctx.flags, 'contentKey')!;
    ctx.progress(`· 正在拉取 A+ 文档 ${key} 关联的 ASIN...`);
    const asins = await fetchAsinsForKey(ctx, mkt, key);
    return deliver(strFlag(ctx.flags, 'out'), {
      marketplace: mkt.country,
      contentReferenceKey: key,
      count: asins.length,
      asins,
    });
  },
};

export const aplusGet: ToolDefinition = {
  service: 'aplus',
  command: 'get',
  description:
    '查看某个 A+ 文档(--content-key)的内容本体:模块结构、全部文案、图片替代文本。' +
    '图片在 API 里只有内部引用没有公开 URL;商品主图/副图请用 listing get(含 images)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 UK / DE / US(必填)', required: true },
    { name: 'content-key', desc: 'A+ 文档的 contentReferenceKey(必填,aplus documents 可查)', required: true },
    { name: 'raw', type: 'boolean', desc: '同时返回未加工的 contentDocument 原始结构(默认只给摘要)' },
    { name: 'out', desc: '把结果(含原始结构)写到该文件路径(可选)' },
  ],
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const key = strFlag(ctx.flags, 'contentKey')!;
    ctx.progress(`· 正在拉取 A+ 文档 ${key} 的内容本体...`);
    const resp = (await ctx.client.get(
      `/aplus/2020-11-01/contentDocuments/${encodeURIComponent(key)}`,
      { marketplaceId: mkt.id, includedDataSet: 'CONTENTS,METADATA' },
      mkt.region,
    )) as {
      contentRecord?: {
        contentReferenceKey?: string;
        contentMetadata?: ContentMetadataRecord['contentMetadata'];
        contentDocument?: {
          name?: string;
          contentType?: string;
          locale?: string;
          contentModuleList?: unknown[];
        };
      };
    };
    const record = resp.contentRecord;
    const doc = record?.contentDocument;
    const modules = doc?.contentModuleList ?? [];
    const wantRaw = ctx.flags['raw'] === true;
    const out = strFlag(ctx.flags, 'out');
    return deliver(out, {
      marketplace: mkt.country,
      contentReferenceKey: record?.contentReferenceKey ?? key,
      name: doc?.name ?? record?.contentMetadata?.name,
      status: record?.contentMetadata?.status,
      contentType: doc?.contentType,
      locale: doc?.locale,
      moduleCount: modules.length,
      modules: summarizeAplusModules(modules),
      // --out 落盘时总是带原始结构(文件不嫌大);stdout 默认只给摘要,--raw 才带
      ...(wantRaw || out ? { contentDocument: doc } : {}),
      note:
        'modules 是加工后的摘要(类型/文案/图片替代文本);A+ 模块里的图片在 API 中' +
        '只有内部引用 ID,拿不到公开 URL。本 API 不覆盖 Premium A+(高级 A+)。',
    });
  },
};

export const aplusCoverage: ToolDefinition = {
  service: 'aplus',
  command: 'coverage',
  description:
    '盘点该站点"有已发布 A+ 的 ASIN":每个 ASIN 一条 {asin,contentReferenceKey,status}(默认只收 APPROVED 状态)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 UK / DE / US(必填)', required: true },
    {
      name: 'status',
      desc: '算作"有 A+"的可接受状态,逗号分隔,默认 APPROVED(官方枚举:APPROVED/DRAFT/REJECTED/SUBMITTED)',
    },
    { name: 'out', desc: '把结果写到该文件路径(可选;结果可能上千条)' },
  ],
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const accepted = (strFlag(ctx.flags, 'status') ?? DEFAULT_APLUS_ACCEPTED_STATUS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const documents = await fetchAllDocuments(ctx, mkt);
    const targets = documents.filter(
      (d) => d.status && accepted.map((s) => s.toUpperCase()).includes(d.status.toUpperCase()),
    );

    const asinsByKey: Record<string, string[]> = {};
    let i = 0;
    for (const doc of targets) {
      i += 1;
      const key = doc.contentReferenceKey!;
      ctx.progress(`· 正在拉取 A+ 文档 ${i}/${targets.length} 的 ASIN...`);
      asinsByKey[key] = await fetchAsinsForKey(ctx, mkt, key);
    }

    const rows = buildAplusCoverage(documents, asinsByKey, accepted);
    return deliver(strFlag(ctx.flags, 'out'), {
      marketplace: mkt.country,
      acceptedStatus: accepted,
      documentsScanned: documents.length,
      documentsAccepted: targets.length,
      count: rows.length,
      items: rows,
      note: '本 API 不覆盖 Premium A+(高级 A+);状态默认只收 APPROVED,可用 --status 调整。',
    });
  },
};
