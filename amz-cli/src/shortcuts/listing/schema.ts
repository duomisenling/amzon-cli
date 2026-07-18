// listing schema —— 查产品类型的最新 schema(该类型所有可填字段:标题/五点/价格/图片/亮点等)
//
// API: Product Type Definitions API 2020-09-01(2026-07-16 从官方 OpenAPI 规范核实)
//   GET /definitions/2020-09-01/productTypes/{productType}?marketplaceIds=...
//   返回 schema.link.resource 是**预签名 URL**;再 fetch 它才拿到真正的完整 JSON Schema;
//   schema.checksum 是内容的 MD5,官方要求核对下载完整性。
//   关键查询参数(均已官方核实):
//     sellerId              传了才返回**卖家专属** schema(含本店品牌等可选值)
//     requirementsEnforced  NOT_ENFORCED = 不强制完整必填约束,适合局部 patch
//                           (官方原文 "such as for partial updates");默认 ENFORCED
//     parentageLevel        变体层级 NONE/CHILD/PARENT,影响条件必填结构
//   requirements 默认 LISTING;productTypeVersion 默认 LATEST(即亚马逊最新结构)。
// 角色:Product Listing
//
// 用途:编辑 listing 前先看这个,拿到字段的确切名字和结构(尤其新增的标题/亮点字段),
// 再用 listing update 照着改——官方推荐的正确姿势,避免凭空拼 patch 结构被拒。

import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../../tools/types.js';
import { AmzError } from '../../internal/errs/errors.js';
import { fetchDocumentBuffer, resolveMarketplace, strFlag } from '../common.js';
import { resolveSellerId } from './mine.js';

interface ProductTypeDefinition {
  displayName?: string;
  productType?: string;
  productTypeVersion?: { version?: string; latest?: boolean };
  propertyGroups?: Record<string, { title?: string; propertyNames?: string[] }>;
  requirements?: string;
  requirementsEnforced?: string;
  locale?: string;
  schema?: { link?: { resource?: string }; checksum?: string };
}

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

interface SchemaTextMatch {
  path: string;
  value: string;
}

const MAX_MATCHED_TEXT_LENGTH = 240;
const MAX_MATCHED_TEXT_PER_ATTRIBUTE = 20;

function displayMatchedText(value: string): string {
  if (value.length <= MAX_MATCHED_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_MATCHED_TEXT_LENGTH - 1)}…`;
}

/**
 * 搜索字段定义中的字符串值，而不是元数据键名。
 * 例如 title_differentiation 的 title 是 "Item Highlight"；若把键名 title
 * 也计入搜索，`--grep title` 会误命中几乎所有带 title 元数据的字段。
 */
function findSchemaTextMatches(
  value: unknown,
  needle: string,
  path: string,
  matches: SchemaTextMatch[] = [],
  limit = MAX_MATCHED_TEXT_PER_ATTRIBUTE + 1,
): SchemaTextMatch[] {
  if (matches.length >= limit) return matches;
  if (typeof value === 'string') {
    if (value.toLowerCase().includes(needle)) {
      matches.push({ path, value: displayMatchedText(value) });
    }
    return matches;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      findSchemaTextMatches(value[index], needle, `${path}[${index}]`, matches, limit);
      if (matches.length >= limit) break;
    }
    return matches;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      findSchemaTextMatches(child, needle, `${path}.${key}`, matches, limit);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function schemaDefinitionSummary(
  attribute: string,
  definition: unknown,
  needle: string,
): {
  attribute: string;
  matchedPaths: string[];
  matchedText: SchemaTextMatch[];
  matchedTextTruncated?: boolean;
  title?: string;
  description?: string;
} {
  const allMatchedText = findSchemaTextMatches(
    definition,
    needle,
    `properties.${attribute}`,
  );
  const matchedTextTruncated = allMatchedText.length > MAX_MATCHED_TEXT_PER_ATTRIBUTE;
  const matchedText = allMatchedText.slice(0, MAX_MATCHED_TEXT_PER_ATTRIBUTE);
  const record = typeof definition === 'object' && definition !== null && !Array.isArray(definition)
    ? definition as Record<string, unknown>
    : undefined;
  return {
    attribute,
    matchedPaths: matchedText.map((match) => match.path),
    matchedText,
    ...(matchedTextTruncated ? { matchedTextTruncated: true } : {}),
    ...(typeof record?.title === 'string' ? { title: record.title } : {}),
    ...(typeof record?.description === 'string' ? { description: record.description } : {}),
  };
}

/** 官方口径为 Base64 MD5;兼容十六进制写法,防上游表示法变化造成误报。 */
function verifySchemaChecksum(buf: Buffer, checksum: string): void {
  const digest = createHash('md5').update(buf).digest();
  const expected = checksum.trim();
  if (digest.toString('base64') === expected) return;
  if (digest.toString('hex') === expected.toLowerCase()) return;
  throw new AmzError({
    type: 'upstream_error',
    subtype: 'schema.checksum_mismatch',
    hintAgent: 'backoff_and_retry',
    hintHuman: '产品类型 schema 下载内容校验失败,可能传输不完整,请重新执行命令。',
    message: 'downloaded product type schema does not match Amazon checksum',
    retryable: true,
  });
}

function parseSchema(buf: Buffer): JsonSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'schema.invalid_json',
      hintAgent: 'backoff_and_retry',
      hintHuman: '亚马逊返回的产品类型 schema 不是有效 JSON,请稍后重新执行命令。',
      message: `product type schema is invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      cause: e,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'schema.invalid_json',
      hintAgent: 'backoff_and_retry',
      hintHuman: '亚马逊返回的产品类型 schema 结构异常,请稍后重新执行命令。',
      message: 'product type schema root is not a JSON object',
      retryable: true,
    });
  }
  return parsed as JsonSchema;
}

export const listingSchema: ToolDefinition = {
  service: 'listing',
  command: 'schema',
  description:
    '查产品类型的最新卖家专属 schema:列出该类型所有可填字段(标题/五点/价格/图片/亮点等)。编辑 listing 前先看这个,拿到字段确切结构再改',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    {
      name: 'product-type',
      desc: '产品类型名(必填;用 listing sku --include productTypes 查某 SKU 的类型)',
      required: true,
    },
    {
      name: 'seller-id',
      desc: '卖家编号(本地模式可省略并读 SELLER_ID;Broker 模式仅用于核对服务端返回值,不能兜底)',
    },
    {
      name: 'requirements-enforced',
      desc: '必填约束模式:局部改字段用 NOT_ENFORCED(默认),检查完整提交用 ENFORCED',
      enum: ['NOT_ENFORCED', 'ENFORCED'],
      default: 'NOT_ENFORCED',
    },
    {
      name: 'parentage-level',
      desc: '变体层级(可选):独立商品 NONE / 变体子体 CHILD / 变体父体 PARENT',
      enum: ['NONE', 'CHILD', 'PARENT'],
    },
    { name: 'attribute', desc: '只看某个字段的完整定义(如 item_name);不传则列出全部字段名' },
    {
      name: 'grep',
      desc: '搜索属性名及字段定义中的 title/description/examples 等字符串(如 title / highlight),方便找显示名与属性名不同的新字段',
    },
    { name: 'raw', type: 'boolean', desc: '返回完整 JSON Schema(可能很大,慎用)' },
  ],
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const productType = strFlag(ctx.flags, 'productType')!;
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const requirementsEnforced = strFlag(ctx.flags, 'requirementsEnforced') ?? 'NOT_ENFORCED';
    const parentageLevel = strFlag(ctx.flags, 'parentageLevel');

    ctx.progress(`· 正在获取 ${productType} 的卖家专属 schema(${mkt.country},最新版本)...`);
    const def = (await ctx.client.get(
      `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`,
      {
        marketplaceIds: mkt.id,
        sellerId,
        productTypeVersion: 'LATEST',
        requirements: 'LISTING',
        requirementsEnforced,
        ...(parentageLevel ? { parentageLevel } : {}),
      },
      mkt.region,
    )) as ProductTypeDefinition;

    const schemaUrl = def.schema?.link?.resource;
    if (!schemaUrl) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'schema.no_link',
        hintAgent: 'report_to_human',
        hintHuman: '亚马逊没有返回 schema 下载地址,请稍后重试。',
        message: `getDefinitionsProductType returned no schema link: ${JSON.stringify(def).slice(0, 300)}`,
      });
    }
    const checksum = def.schema?.checksum?.trim();
    if (!checksum) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'schema.no_checksum',
        hintAgent: 'report_to_human',
        hintHuman: '亚马逊没有返回 schema 校验值,无法确认下载内容完整性,请稍后重试。',
        message: 'getDefinitionsProductType returned no schema checksum',
      });
    }

    ctx.progress('· 正在下载 schema 内容(预签名地址)...');
    const buf = await fetchDocumentBuffer(schemaUrl, {
      gzip: false,
      what: '产品类型 schema',
      subtype: 'schema.download_failed',
    });
    verifySchemaChecksum(buf, checksum);
    const schema = parseSchema(buf);
    const props = schema.properties ?? {};

    const resolvedProductType = def.productType ?? productType;
    const meta = {
      productType: resolvedProductType,
      displayName: def.displayName,
      marketplace: mkt.country,
      version: def.productTypeVersion?.version,
      locale: def.locale,
      requirementsEnforced: def.requirementsEnforced ?? requirementsEnforced,
      ...(parentageLevel ? { parentageLevel } : {}),
    };

    // ① 看单个字段的完整定义
    const attr = strFlag(ctx.flags, 'attribute');
    if (attr) {
      if (!(attr in props)) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'schema.attribute_not_found',
          param: '--attribute',
          hintAgent: 'fix_param',
          hintHuman: `字段 "${attr}" 不在 ${resolvedProductType} 的 schema 里。不带 --attribute 可列出全部字段名。`,
          message: `attribute ${attr} not found in schema`,
        });
      }
      return { ...meta, attribute: attr, definition: props[attr] };
    }

    // ② 完整 schema
    if (ctx.flags['raw']) {
      return { ...meta, schema };
    }

    // ③ 默认:字段名概览(可用 --grep 搜索属性名和字段定义中的文本元数据)
    const grep = strFlag(ctx.flags, 'grep')?.toLowerCase();
    const allNames = Object.keys(props).sort();
    const matches = grep
      ? allNames
          .map((name) => ({
            ...schemaDefinitionSummary(name, props[name], grep),
            nameMatched: name.toLowerCase().includes(grep),
          }))
          .filter((match) => match.nameMatched || match.matchedText.length > 0)
          .map(({ nameMatched: _nameMatched, ...match }) => match)
      : [];
    const names = grep ? matches.map((match) => match.attribute) : allNames;

    return {
      ...meta,
      totalAttributes: allNames.length,
      // NOT_ENFORCED 下顶层 required 通常为空,这是预期行为(局部 patch 不需要全量必填)
      topLevelRequiredAttributes: schema.required ?? [],
      ...(grep ? { grep, matched: names.length, matches } : {}),
      attributes: names,
      hint:
        '用 --attribute <字段名> 看某个字段的完整结构;--grep <关键词> 搜索属性名及字段定义文本;--raw 看完整 schema',
    };
  },
};
