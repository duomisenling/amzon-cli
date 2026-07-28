// listing update —— 编辑自己店铺的 listing(价格/图片等字段)【写操作,reversible】
//
// API: Listings Items API 2021-08-01 patchListingsItem
//   PATCH /listings/2021-08-01/items/{sellerId}/{sku}
// (2026-07-13 从官方 OpenAPI 规范核实:
//   body = {productType, patches:[{op,path,value}]}(JSON Patch 约定);
//   query mode=VALIDATION_PREVIEW —— 官方原文:同步执行与正式提交完全相同的
//   校验,但不落库。规格 §7.2 明确要求 dry-run 直接用这个官方参数,
//   不自己造预览逻辑。
//   响应:{sku, status: ACCEPTED|VALID|INVALID, submissionId, issues[]})
//
// 门槛(框架强制):
//   amz-cli listing update ... --dry-run   → 拉当前值 + 服务端校验预览
//   amz-cli listing update ... --confirm --preview-token <令牌> → 真正提交
//   两条独立命令,中间必须有人看过预览(规格 §8.2)。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';
import { resolveSellerId, resolveUniqueListingSku } from './mine.js';
import { isSandboxMode } from '../../internal/client/regions.js';
import { loadListingSchema } from './schema.js';

interface JsonPatch {
  op: 'add' | 'replace' | 'merge' | 'delete';
  path: string;
  value?: Array<Record<string, unknown>>;
}

interface ListingConfirmationState {
  sandbox?: boolean;
  sellerId?: string;
  region?: string;
  marketplaceId?: string;
  sku?: string;
  asin?: string;
  currentValues?: Record<string, unknown>;
  schemaEvidence?: ListingSchemaEvidence;
}

interface ListingSchemaAttributeEvidence {
  exists: boolean;
  editable?: boolean;
  title?: string;
}

interface ListingSchemaEvidence {
  sellerId: string;
  marketplaceId: string;
  productType: string;
  version?: string;
  checksum: string;
  requirementsEnforced: string;
  attributes: Record<string, ListingSchemaAttributeEvidence>;
}

const PATCH_OPS = new Set<JsonPatch['op']>(['add', 'replace', 'merge', 'delete']);
const PATCH_OPS_REQUIRING_VALUE = new Set<JsonPatch['op']>(['add', 'replace', 'merge']);
const MERGE_PATHS = new Set([
  '/attributes/fulfillment_availability',
  '/attributes/purchasable_offer',
]);

function parsePatches(flags: Record<string, unknown>): JsonPatch[] {
  let raw = strFlag(flags, 'patches');
  if (!raw) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'missing_patches',
      param: '--patches',
      hintAgent: 'fix_param',
      hintHuman:
        '请用 --patches 提供 JSON Patch 数组(或 @文件路径 从文件读取)。' +
        '示例:--patches @patch.json,文件内容形如 [{"op":"replace","path":"/attributes/...","value":[...]}]',
      message: '--patches is required',
    });
  }
  // @文件路径:从文件读 JSON —— 避开 PowerShell 等 shell 的引号转义问题,也便于大改动
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'patches_file_unreadable',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman: `读不到 patches 文件 "${path}",请检查路径是否正确。`,
        message: `cannot read patches file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_patches_json',
      param: '--patches',
      hintAgent: 'fix_param',
      hintHuman: '--patches 不是合法的 JSON,请检查引号与转义。',
      message: `--patches is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_patches_shape',
      param: '--patches',
      hintAgent: 'fix_param',
      hintHuman: '--patches 必须是非空 JSON 数组,每项包含 op / path(/ value)。',
      message: '--patches must be a non-empty array of JSON Patch operations',
    });
  }
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_patch_op',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman: `第 ${index + 1} 个 patch 必须是 JSON 对象。`,
        message: `patch item ${index + 1} is not an object: ${JSON.stringify(item)}`,
      });
    }
    const p = item as Record<string, unknown>;
    if (typeof p.op !== 'string' || !PATCH_OPS.has(p.op as JsonPatch['op'])) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_patch_operation',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman: `第 ${index + 1} 个 patch 的 op 无效,只能是 add / replace / merge / delete。`,
        message: `unsupported patch op at item ${index + 1}: ${JSON.stringify(p.op)}`,
      });
    }
    if (typeof p.path !== 'string' || !/^\/attributes\/[^/]+$/.test(p.path)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_patch_path',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman:
          `第 ${index + 1} 个 patch 的 path 无效。Listings Items API 只能修改顶层属性,` +
          '格式必须是 /attributes/<字段名>,不能继续写嵌套路径。',
        message: `patch path at item ${index + 1} must target one top-level attribute: ${JSON.stringify(p.path)}`,
      });
    }
    if (PATCH_OPS_REQUIRING_VALUE.has(p.op as JsonPatch['op']) && !('value' in p)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'missing_patch_value',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman: `第 ${index + 1} 个 patch 使用 ${String(p.op)} 操作时必须提供 value。`,
        message: `patch value is required for ${String(p.op)} at item ${index + 1}`,
      });
    }
    if (p.op === 'merge' && !MERGE_PATHS.has(p.path as string)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'unsupported_merge_path',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman:
          `第 ${index + 1} 个 patch 的 merge 路径不受 Amazon 支持。` +
          '当前只能用于 /attributes/fulfillment_availability 或 /attributes/purchasable_offer。',
        message: `merge is not supported for path at item ${index + 1}: ${JSON.stringify(p.path)}`,
      });
    }
    if (
      'value' in p &&
      (!Array.isArray(p.value) ||
        p.value.some((value) => typeof value !== 'object' || value === null || Array.isArray(value)))
    ) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_patch_value',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman: `第 ${index + 1} 个 patch 的 value 必须是 JSON 对象数组,具体对象结构以 listing schema 为准。`,
        message: `patch value at item ${index + 1} must be an array of objects`,
      });
    }
  }
  return parsed as JsonPatch[];
}

/** 从 patch path(/attributes/xxx/...)提取顶层属性名,用于展示当前值对照。 */
function touchedAttributes(patches: JsonPatch[]): string[] {
  const names = new Set<string>();
  for (const p of patches) {
    const m = /^\/attributes\/([^/]+)/.exec(p.path);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

function schemaAttributeEvidence(definition: unknown): ListingSchemaAttributeEvidence {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return { exists: true };
  }
  const record = definition as Record<string, unknown>;
  return {
    exists: true,
    ...(typeof record['editable'] === 'boolean' ? { editable: record['editable'] } : {}),
    ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
  };
}

async function captureListingSchemaEvidence(
  ctx: ToolContext,
  patches: JsonPatch[],
): Promise<ListingSchemaEvidence> {
  const loaded = await loadListingSchema(ctx);
  const properties = loaded.schema.properties ?? {};
  const attributes = Object.fromEntries(
    touchedAttributes(patches).map((attribute) => [
      attribute,
      Object.prototype.hasOwnProperty.call(properties, attribute)
        ? schemaAttributeEvidence(properties[attribute])
        : { exists: false },
    ]),
  );
  return {
    sellerId: loaded.sellerId,
    marketplaceId: loaded.marketplaceId,
    productType: loaded.productType,
    ...(loaded.version ? { version: loaded.version } : {}),
    checksum: loaded.checksum,
    requirementsEnforced: loaded.requirementsEnforced,
    attributes,
  };
}

function assertSchemaAllowsPatches(
  patches: JsonPatch[],
  evidence: ListingSchemaEvidence | undefined,
): ListingSchemaEvidence {
  if (!evidence) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'listing.schema_evidence_missing',
      hintAgent: 'report_to_human',
      hintHuman: 'Listing 预览没有取得卖家专属 Schema 证据，已停止写入。请重新生成预览。',
      message: 'seller-specific product type schema evidence is missing',
      retryable: true,
    });
  }
  for (const attribute of touchedAttributes(patches)) {
    const checked = evidence.attributes[attribute];
    if (!checked?.exists) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'listing.schema_attribute_not_found',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman:
          `属性 "${attribute}" 不在当前店铺、站点和商品类型的最新 Schema 中，已禁止预览和写入。` +
          '请先用 inspect_listing_schema 按业务名称搜索真实属性；找不到或匹配多个时询问用户，不得继续猜字段名。',
        message:
          `attribute ${attribute} is absent from seller-specific schema ` +
          `${evidence.productType}@${evidence.marketplaceId}`,
      });
    }
    if (checked.editable === false) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'listing.schema_attribute_not_editable',
        param: '--patches',
        hintAgent: 'report_to_human',
        hintHuman:
          `属性 "${attribute}" 在当前卖家专属 Schema 中明确标记为不可编辑，已禁止预览和写入。` +
          '请向用户说明本次 Schema 证据，不要更换字段名反复尝试。',
        message:
          `attribute ${attribute} is not editable in seller-specific schema ` +
          `${evidence.productType}@${evidence.marketplaceId}`,
      });
    }
  }
  return evidence;
}

function validateListingIdentifier(flags: Record<string, unknown>): void {
  const sku = strFlag(flags, 'sku')?.trim();
  const asin = strFlag(flags, 'asin')?.trim();
  if (!sku && !asin) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'listing.missing_identifier',
      param: '--sku/--asin',
      hintAgent: 'fix_param',
      hintHuman: '请提供 SKU 或 ASIN。只有 ASIN 时，程序会先查询当前店铺对应的 SKU；不会猜测。',
      message: 'listing update requires --sku or --asin',
    });
  }
  if (asin && !/^[A-Z0-9]{10}$/i.test(asin)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'listing.invalid_asin',
      param: '--asin',
      hintAgent: 'fix_param',
      hintHuman: 'ASIN 必须是 10 位字母或数字。请核对商品详情页 /dp/ 后面的编号。',
      message: `invalid ASIN: ${JSON.stringify(asin)}`,
    });
  }
}

async function resolveListingTarget(ctx: ToolContext): Promise<{
  sellerId: string;
  region: string;
  marketplaceId: string;
  sku: string;
  asin?: string;
}> {
  const mkt = resolveMarketplace(ctx.flags['marketplace']);
  const state = listingStateFromContext(ctx);
  if (
    state.sellerId &&
    state.region === mkt.region &&
    state.marketplaceId === mkt.id &&
    state.sku
  ) {
    return {
      sellerId: state.sellerId,
      region: state.region,
      marketplaceId: state.marketplaceId,
      sku: state.sku,
      ...(state.asin ? { asin: state.asin } : {}),
    };
  }

  const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
  const sku = strFlag(ctx.flags, 'sku')?.trim();
  const asin = strFlag(ctx.flags, 'asin')?.trim().toUpperCase();
  if (asin) {
    const resolved = await resolveUniqueListingSku(ctx.flags, ctx.client, sku);
    return {
      sellerId,
      region: mkt.region,
      marketplaceId: mkt.id,
      sku: resolved.sku,
      asin: resolved.asin,
    };
  }
  return {
    sellerId,
    region: mkt.region,
    marketplaceId: mkt.id,
    sku: sku!,
  };
}

async function captureListingState(ctx: ToolContext): Promise<ListingConfirmationState> {
  if (isSandboxMode()) return { sandbox: true };
  const patches = parsePatches(ctx.flags);
  const mkt = resolveMarketplace(ctx.flags['marketplace']);
  const target = await resolveListingTarget(ctx);
  const [current, schemaEvidence] = await Promise.all([
    ctx.client.get(
      `/listings/2021-08-01/items/${encodeURIComponent(target.sellerId)}/${encodeURIComponent(target.sku)}`,
      { marketplaceIds: mkt.id, includedData: 'summaries,attributes' },
      mkt.region,
    ) as Promise<{ attributes?: Record<string, unknown> }>,
    captureListingSchemaEvidence(ctx, patches),
  ]);
  if (
    schemaEvidence.sellerId !== target.sellerId ||
    schemaEvidence.marketplaceId !== target.marketplaceId
  ) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'listing.schema_identity_mismatch',
      hintAgent: 'report_to_human',
      hintHuman: 'Schema 所属店铺或站点与 Listing 目标不一致，已停止预览。请核对店铺和站点后重试。',
      message:
        `schema identity ${schemaEvidence.sellerId}@${schemaEvidence.marketplaceId} ` +
        `does not match listing target ${target.sellerId}@${target.marketplaceId}`,
    });
  }
  const currentValues: Record<string, unknown> = {};
  for (const name of touchedAttributes(patches)) {
    currentValues[name] = current.attributes?.[name] ?? '(当前无此属性)';
  }
  return {
    sellerId: target.sellerId,
    region: mkt.region,
    marketplaceId: mkt.id,
    sku: target.sku,
    ...(target.asin ? { asin: target.asin } : {}),
    currentValues,
    schemaEvidence,
  };
}

function listingStateFromContext(ctx: ToolContext): ListingConfirmationState {
  const state = ctx.confirmationState;
  return state && typeof state === 'object' && !Array.isArray(state)
    ? state as ListingConfirmationState
    : {};
}

async function callPatch(
  ctx: ToolContext,
  opts: { validationPreview: boolean; patches?: JsonPatch[] },
): Promise<Record<string, unknown>> {
  const mkt = resolveMarketplace(ctx.flags['marketplace']);
  const target = await resolveListingTarget(ctx);
  const productType = strFlag(ctx.flags, 'productType')!;
  const patches = opts.patches ?? parsePatches(ctx.flags);

  // 官方模型原文:includedData 的 identifiers "Can only be requested when mode
  // is VALIDATION_PREVIEW"。所以只有预览带 identifiers;正式提交只请求 issues,
  // 否则真实 PATCH 可能因非法查询参数被拒(2026-07-16 从官方 OpenAPI 规范核实)。
  const query: Record<string, string> = {
    marketplaceIds: mkt.id,
    includedData: opts.validationPreview ? 'identifiers,issues' : 'issues',
  };
  if (opts.validationPreview) query['mode'] = 'VALIDATION_PREVIEW';

  const url =
    `/listings/2021-08-01/items/${encodeURIComponent(target.sellerId)}/${encodeURIComponent(target.sku)}` +
    `?${new URLSearchParams(query).toString()}`;

  return (await ctx.client.request('PATCH', url, {
    body: { productType, patches },
    region: mkt.region,
  })) as Record<string, unknown>;
}

function assertValidationPassed(validation: Record<string, unknown>): void {
  const issues = Array.isArray(validation.issues)
    ? validation.issues.filter((issue): issue is Record<string, unknown> =>
        typeof issue === 'object' && issue !== null && !Array.isArray(issue))
    : [];
  const errors = issues.filter(
    (issue) => typeof issue.severity === 'string' && issue.severity.toUpperCase() === 'ERROR',
  );
  if (validation.status === 'VALID' && errors.length === 0) return;

  if (validation.status === 'INVALID' || errors.length > 0) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'listing.validation_failed',
      param: '--patches',
      hintAgent: 'fix_param',
      hintHuman:
        `Amazon 预览校验未通过(status=${String(validation.status ?? 'missing')},` +
        `ERROR=${errors.length})。请根据 issues 修正 patch 后重新 --dry-run；本次不会生成确认令牌。`,
      message: `listing validation preview failed: ${JSON.stringify(validation).slice(0, 2000)}`,
    });
  }

  throw new AmzError({
    type: 'upstream_error',
    subtype: 'listing.validation_unexpected_status',
    hintAgent: 'report_to_human',
    hintHuman:
      `Amazon 预览返回了非预期状态 ${String(validation.status ?? 'missing')}。` +
      '为安全起见本次不会生成确认令牌,请稍后重新预览。',
    message: `unexpected listing validation preview response: ${JSON.stringify(validation).slice(0, 2000)}`,
    retryable: true,
  });
}

function assertSubmissionAccepted(submission: Record<string, unknown>): void {
  if (submission.status === 'ACCEPTED') return;
  if (submission.status === 'INVALID') {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'listing.submission_rejected',
      param: '--patches',
      hintAgent: 'fix_param',
      hintHuman: 'Amazon 正式提交返回 INVALID，本次修改未被接受。请根据 issues 修正后重新预览。',
      message: `listing submission rejected: ${JSON.stringify(submission).slice(0, 2000)}`,
    });
  }
  throw new AmzError({
    type: 'upstream_error',
    subtype: 'listing.submission_status_unknown',
    hintAgent: 'report_to_human',
    hintHuman:
      `Amazon 正式提交返回非预期状态 ${String(submission.status ?? 'missing')}，无法确认是否接受。` +
      '不要自动重试，请先用 listing sku 或 Seller Central 核对。',
    message: `unexpected listing submission response: ${JSON.stringify(submission).slice(0, 2000)}`,
  });
}

export const listingUpdate: ToolDefinition = {
  service: 'listing',
  command: 'update',
  description:
    '编辑自己店铺的 listing 字段(价格/图片等)。写操作:必须先 --dry-run 预览(官方服务端校验),人工确认后另起命令 --confirm 执行',
  mutation: 'reversible',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'sku', desc: '本店铺要修改的 SKU；可与 --asin 一起提供用于交叉核对' },
    { name: 'asin', desc: '商品 ASIN；程序会先查询本店 SKU，非唯一匹配时停止并要求用户确认' },
    {
      name: 'seller-id',
      desc: '卖家编号(本地模式可省略并读 SELLER_ID;Broker 模式仅用于核对服务端返回值,不能兜底)',
    },
    {
      name: 'product-type',
      desc: '亚马逊产品类型(必填;可先用 listing sku --include productTypes 查到)',
      required: true,
    },
    {
      name: 'patches',
      desc: 'JSON Patch 数组,或 @文件路径 从文件读(PowerShell 里推荐用 @文件,避开引号问题)',
      required: true,
    },
  ],
  validate: (flags) => {
    validateListingIdentifier(flags);
    parsePatches(flags); // 提前校验 JSON 结构,坏参数不消耗 API 调用
  },
  describe: (flags) => {
    const patches = parsePatches(flags);
    const attrs = touchedAttributes(patches);
    return (
      `修改 ${strFlag(flags, 'marketplace')?.toUpperCase()} 站点 ` +
      (strFlag(flags, 'sku')
        ? `SKU「${strFlag(flags, 'sku')}」`
        : `ASIN「${strFlag(flags, 'asin')}」（预览前解析为本店 SKU）`) +
      ' 的 listing:' +
      `共 ${patches.length} 处改动` +
      (attrs.length ? `,涉及属性:${attrs.join('、')}` : '') +
      `(操作:${patches.map((p) => p.op).join('/')})`
    );
  },
  confirmationInput: (flags) => {
    const patches = parsePatches(flags);
    return {
      snapshot: {
        patchesSha256: createHash('sha256').update(JSON.stringify(patches)).digest('hex'),
      },
      input: patches,
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
  confirmationStateSnapshot: captureListingState,
  dryRun: async (ctx) => {
    const patches = parsePatches(ctx.flags);
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const target = await resolveListingTarget(ctx);

    // 沙盒模式:静态沙盒只匹配预定义参数,拉当前值一步没有对应 mock,
    // 跳过它直接验证 VALIDATION_PREVIEW 链路(沙盒专用 SKU:VALIDATION_VALID / VALIDATION_INVALID)
    if (isSandboxMode()) {
      ctx.progress('· [沙盒 dry-run] 跳过当前值拉取,直接调 VALIDATION_PREVIEW...');
      const validation = await callPatch(ctx, { validationPreview: true });
      assertValidationPassed(validation);
      return {
        sku: target.sku,
        ...(target.asin ? { resolvedFromAsin: target.asin } : {}),
        marketplace: mkt.country,
        sandbox: true,
        proposed_patches: patches,
        validation,
      };
    }

    // 规格 §8.2 rule 3:必须先展示当前状态做对照,不能盲改
    // (当前值由框架门禁在预览前通过 confirmationStateSnapshot 拉取并绑定进令牌)
    ctx.progress('· [dry-run 1/2] 载入门禁预读的当前 listing 值做对照...');
    const confirmationState = listingStateFromContext(ctx);
    const currentTouched = confirmationState.currentValues ?? {};
    const schemaEvidence = assertSchemaAllowsPatches(patches, confirmationState.schemaEvidence);

    ctx.progress('· [dry-run 2/2] 调用官方 VALIDATION_PREVIEW 服务端校验(不落库)...');
    const validation = await callPatch(ctx, { validationPreview: true });
    assertValidationPassed(validation);

    return {
      sku: target.sku,
      ...(target.asin ? { resolvedFromAsin: target.asin } : {}),
      marketplace: mkt.country,
      changes: {
        current_values: currentTouched,
        proposed_patches: patches,
      },
      schemaValidation: {
        marketplaceId: schemaEvidence.marketplaceId,
        productType: schemaEvidence.productType,
        version: schemaEvidence.version,
        checksum: schemaEvidence.checksum,
        requirementsEnforced: schemaEvidence.requirementsEnforced,
        attributes: schemaEvidence.attributes,
      },
      validation,
      next:
        '人工核对以上"当前值 → 改动"无误后,在 15 分钟内凭本次预览令牌、' +
        '以完全相同的业务参数执行正式提交',
    };
  },
  execute: async (ctx) => {
    ctx.progress('· 正在提交 listing 修改...');
    const confirmedPatches = Array.isArray(ctx.confirmedInput)
      ? (ctx.confirmedInput as JsonPatch[])
      : undefined;
    const submission = await callPatch(ctx, {
      validationPreview: false,
      patches: confirmedPatches,
    });
    assertSubmissionAccepted(submission);
    // PATCH 已被 Amazon 接受。从这里起任何回读准备/读取失败都只能记录为 readbackError,
    // 必须照常返回 SUBMITTED——否则会把已成功的提交误报成失败,诱导危险的重复提交。
    let immediateReadback: unknown;
    let readbackError: string | undefined;
    try {
      const mkt = resolveMarketplace(ctx.flags['marketplace']);
      const target = await resolveListingTarget(ctx);
      immediateReadback = await ctx.client.get(
        `/listings/2021-08-01/items/${encodeURIComponent(target.sellerId)}/${encodeURIComponent(target.sku)}`,
        { marketplaceIds: mkt.id, includedData: 'attributes,issues' },
        mkt.region,
      );
    } catch (error) {
      readbackError = error instanceof Error ? error.message : String(error);
    }
    return {
      processingStatus: 'SUBMITTED',
      sku: listingStateFromContext(ctx).sku ?? strFlag(ctx.flags, 'sku'),
      ...(listingStateFromContext(ctx).asin
        ? { resolvedFromAsin: listingStateFromContext(ctx).asin }
        : {}),
      submission,
      ...(immediateReadback !== undefined ? { immediateReadback } : {}),
      ...(readbackError ? { readbackError } : {}),
      note:
        '正式 PATCH 已提交。即时回读可能仍是旧值；Amazon 会继续异步处理目录数据，' +
        '不能仅凭本响应宣称前台已最终生效。请稍后用 listing sku --include attributes,issues 复核。',
    };
  },
};
