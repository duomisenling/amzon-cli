// listing create —— 引导式新建自己店铺的 listing【写操作,reversible】
//
// API: Listings Items API 2021-08-01 putListingsItem
//   PUT /listings/2021-08-01/items/{sellerId}/{sku}
//   body = {productType, requirements, attributes};支持 mode=VALIDATION_PREVIEW
//   (与 patchListingsItem 同款:官方服务端做与正式提交完全相同的校验但不落库)
//   响应:{sku, status: ACCEPTED|VALID|INVALID, submissionId, issues[]}
//
// "引导式"= 不自造校验:dry-run 直接调官方 VALIDATION_PREVIEW,把缺的必填属性/
//   非法值全列出来给人和 Agent 看;配合 inspect_listing_schema(查真实属性名)形成
//   "查 schema → 填属性 → 预览(官方校验)→ 修 → 确认"闭环,避免 Agent 摸索字段名。
//
// 门槛(框架强制):--dry-run 预览(官方校验+SKU 是否已存在)→ 人工 --confirm 执行。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';
import { resolveSellerId } from './mine.js';
import { isSandboxMode } from '../../internal/client/regions.js';

const REQUIREMENTS = ['LISTING', 'LISTING_OFFER_ONLY', 'LISTING_PRODUCT_ONLY'];

interface CreateConfirmationState {
  sandbox?: boolean;
  sellerId?: string;
  region?: string;
  marketplaceId?: string;
  sku?: string;
  /** 该 SKU 是否已存在(存在则 create 会覆盖,dry-run 会警示) */
  skuExists?: boolean;
}

/** 读取 --attributes(@文件路径 或内联 JSON 对象),校验成非空对象。 */
export function parseAttributes(flags: Record<string, unknown>): Record<string, unknown> {
  let raw = strFlag(flags, 'attributes');
  if (!raw) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'listing.create_missing_attributes', param: '--attributes', hintAgent: 'fix_param',
      hintHuman:
        '请用 --attributes 提供属性 JSON 对象(或 @文件路径)。属性名以 inspect_listing_schema / listing schema 为准,' +
        '例:{"item_name":[{"value":"…","marketplace_id":"…"}], "brand":[{"value":"…"}], …}',
      message: '--attributes is required',
    });
  }
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      throw new AmzError({
        type: 'invalid_param', subtype: 'listing.create_attributes_file_unreadable', param: '--attributes', hintAgent: 'fix_param',
        hintHuman: `读不到属性文件 "${path}"。`, message: `cannot read attributes file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'listing.create_attributes_bad_json', param: '--attributes', hintAgent: 'fix_param',
      hintHuman: '--attributes 不是合法 JSON,请检查引号与转义(PowerShell 里建议用 @文件)。', message: `--attributes is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'listing.create_attributes_shape', param: '--attributes', hintAgent: 'fix_param',
      hintHuman: '--attributes 必须是非空 JSON 对象:{属性名: [ {value…} ]}。', message: '--attributes must be a non-empty JSON object',
    });
  }
  return parsed as Record<string, unknown>;
}

function requirementsOf(flags: Record<string, unknown>): string {
  return strFlag(flags, 'requirements') ?? 'LISTING';
}

function createStateFromContext(ctx: ToolContext): CreateConfirmationState {
  const state = ctx.confirmationState;
  return state && typeof state === 'object' && !Array.isArray(state) ? (state as CreateConfirmationState) : {};
}

/** 调 PUT putListingsItem;validationPreview=true 走官方校验(不落库)。 */
async function callPut(
  ctx: ToolContext,
  attributes: Record<string, unknown>,
  validationPreview: boolean,
): Promise<Record<string, unknown>> {
  const mkt = resolveMarketplace(ctx.flags['marketplace']);
  const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
  const sku = strFlag(ctx.flags, 'sku')!;
  const productType = strFlag(ctx.flags, 'productType')!;

  const query: Record<string, string> = { marketplaceIds: mkt.id, includedData: 'issues' };
  if (validationPreview) query['mode'] = 'VALIDATION_PREVIEW';
  const url =
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}` +
    `?${new URLSearchParams(query).toString()}`;

  return (await ctx.client.request('PUT', url, {
    body: { productType, requirements: requirementsOf(ctx.flags), attributes },
    region: mkt.region,
  })) as Record<string, unknown>;
}

export function assertValidationPassed(validation: Record<string, unknown>): void {
  const issues = Array.isArray(validation.issues)
    ? validation.issues.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && !Array.isArray(i))
    : [];
  const errors = issues.filter((i) => typeof i.severity === 'string' && i.severity.toUpperCase() === 'ERROR');
  if (validation.status === 'VALID' && errors.length === 0) return;
  if (validation.status === 'INVALID' || errors.length > 0) {
    throw new AmzError({
      type: 'invalid_param', subtype: 'listing.create_validation_failed', param: '--attributes', hintAgent: 'fix_param',
      hintHuman:
        `Amazon 预览校验未通过(status=${String(validation.status ?? 'missing')},ERROR=${errors.length})。` +
        '请按 issues 补齐缺失的必填属性或修正值后重新 --dry-run;本次不签发确认令牌。',
      message: `listing create validation preview failed: ${JSON.stringify(validation).slice(0, 2000)}`,
    });
  }
  throw new AmzError({
    type: 'upstream_error', subtype: 'listing.create_validation_unexpected', hintAgent: 'report_to_human',
    hintHuman: `Amazon 预览返回非预期状态 ${String(validation.status ?? 'missing')},为安全起见不签发令牌,请稍后重试。`,
    message: `unexpected listing create validation response: ${JSON.stringify(validation).slice(0, 2000)}`, retryable: true,
  });
}

export function assertSubmissionAccepted(submission: Record<string, unknown>): void {
  if (submission.status === 'ACCEPTED') return;
  if (submission.status === 'INVALID') {
    throw new AmzError({
      type: 'invalid_param', subtype: 'listing.create_submission_rejected', param: '--attributes', hintAgent: 'fix_param',
      hintHuman: 'Amazon 正式提交返回 INVALID,新建未被接受。请按 issues 修正后重新预览。',
      message: `listing create submission rejected: ${JSON.stringify(submission).slice(0, 2000)}`,
    });
  }
  throw new AmzError({
    type: 'upstream_error', subtype: 'listing.create_submission_status_unknown', hintAgent: 'report_to_human',
    hintHuman:
      `Amazon 正式提交返回非预期状态 ${String(submission.status ?? 'missing')},无法确认是否接受。` +
      '不要自动重试,请用 listing sku 或 Seller Central 核对。',
    message: `unexpected listing create submission response: ${JSON.stringify(submission).slice(0, 2000)}`,
  });
}

export const listingCreate: ToolDefinition = {
  service: 'listing',
  command: 'create',
  description:
    '引导式新建自己店铺的 listing。写操作:--dry-run 走官方 VALIDATION_PREVIEW(会列出缺的必填属性)→ 人工 --confirm 执行。' +
    '属性名先用 listing schema / inspect_listing_schema 查准,别猜',
  mutation: 'reversible',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'sku', desc: '要新建的 SKU(必填;已存在则会覆盖,dry-run 会警示)', required: true },
    { name: 'seller-id', desc: '卖家编号(本地模式可省并读 SELLER_ID)' },
    { name: 'product-type', desc: '亚马逊产品类型(必填;用 listing schema 查)', required: true },
    { name: 'attributes', desc: '属性 JSON 对象,或 @文件路径(PowerShell 推荐 @文件)', required: true },
    { name: 'requirements', desc: `要求集,默认 LISTING。可选:${REQUIREMENTS.join(' / ')}`, enum: REQUIREMENTS },
  ],
  validate: (flags) => {
    parseAttributes(flags); // 提前校验 JSON 结构
  },
  describe: (flags) => {
    const attrs = parseAttributes(flags);
    return (
      `在 ${strFlag(flags, 'marketplace')?.toUpperCase()} 站新建 listing SKU「${strFlag(flags, 'sku')}」` +
      `(productType ${strFlag(flags, 'productType')},${Object.keys(attrs).length} 个属性)——会发布到 Amazon`
    );
  },
  confirmationInput: (flags) => {
    const attributes = parseAttributes(flags);
    return {
      snapshot: { attributesSha256: createHash('sha256').update(JSON.stringify(attributes)).digest('hex') },
      input: attributes,
    };
  },
  confirmationRuntimeSnapshot: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    return {
      sellerId: await resolveSellerId(ctx.flags, mkt.region, ctx.client),
      region: mkt.region,
      marketplaceId: mkt.id,
    };
  },
  confirmationStateSnapshot: async (ctx): Promise<CreateConfirmationState> => {
    if (isSandboxMode()) return { sandbox: true };
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const sku = strFlag(ctx.flags, 'sku')!;
    // SKU 是否已存在:存在→create 会覆盖。把这个事实绑进令牌,防止预览到确认之间被人建了同名 SKU。
    let skuExists = false;
    try {
      await ctx.client.get(
        `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
        { marketplaceIds: mkt.id, includedData: 'summaries' },
        mkt.region,
      );
      skuExists = true;
    } catch (err) {
      if (err instanceof AmzError && err.subtype === 'sp_api.not_found') skuExists = false;
      else throw err;
    }
    return { sellerId, region: mkt.region, marketplaceId: mkt.id, sku, skuExists };
  },
  dryRun: async (ctx) => {
    const attributes = parseAttributes(ctx.flags);
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sku = strFlag(ctx.flags, 'sku')!;
    const state = createStateFromContext(ctx);

    ctx.progress('· [dry-run] 调用官方 VALIDATION_PREVIEW 校验新建属性(不落库)...');
    const validation = await callPut(ctx, attributes, true);
    assertValidationPassed(validation);

    return {
      sku,
      marketplace: mkt.country,
      productType: strFlag(ctx.flags, 'productType'),
      requirements: requirementsOf(ctx.flags),
      willOverwriteExisting: state.skuExists === true,
      ...(state.skuExists
        ? { warning: `⚠️ SKU「${sku}」已存在,create 将覆盖它的属性。若只想改字段请改用 listing update。` }
        : {}),
      attributeCount: Object.keys(attributes).length,
      attributes,
      validation,
      next: '人工核对属性与校验结果无误后,15 分钟内凭本次预览令牌以完全相同参数 --confirm 执行正式新建。',
    };
  },
  execute: async (ctx) => {
    const attributes = (ctx.confirmedInput && typeof ctx.confirmedInput === 'object' && !Array.isArray(ctx.confirmedInput))
      ? (ctx.confirmedInput as Record<string, unknown>)
      : parseAttributes(ctx.flags);
    ctx.progress('· 正在提交新建 listing...');
    const submission = await callPut(ctx, attributes, false);
    assertSubmissionAccepted(submission);

    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sku = strFlag(ctx.flags, 'sku')!;
    let immediateReadback: unknown;
    let readbackError: string | undefined;
    try {
      const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
      immediateReadback = await ctx.client.get(
        `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
        { marketplaceIds: mkt.id, includedData: 'summaries,issues' },
        mkt.region,
      );
    } catch (error) {
      readbackError = error instanceof Error ? error.message : String(error);
    }
    return {
      processingStatus: 'SUBMITTED',
      sku,
      marketplace: mkt.country,
      submission,
      ...(immediateReadback !== undefined ? { immediateReadback } : {}),
      ...(readbackError ? { readbackError } : {}),
      note:
        '新建已提交。Amazon 异步处理目录数据,即时回读可能还没生效;请稍后用 listing sku --include summaries,issues 复核上架状态。',
    };
  },
};
