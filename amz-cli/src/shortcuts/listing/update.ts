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
import { resolveSellerId } from './mine.js';
import { isSandboxMode } from '../../internal/client/regions.js';

interface JsonPatch {
  op: 'add' | 'replace' | 'merge' | 'delete';
  path: string;
  value?: Array<Record<string, unknown>>;
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

async function callPatch(
  ctx: ToolContext,
  opts: { validationPreview: boolean; patches?: JsonPatch[] },
): Promise<Record<string, unknown>> {
  const mkt = resolveMarketplace(ctx.flags['marketplace']);
  const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
  const sku = strFlag(ctx.flags, 'sku')!;
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
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}` +
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

export const listingUpdate: ToolDefinition = {
  service: 'listing',
  command: 'update',
  description:
    '编辑自己店铺的 listing 字段(价格/图片等)。写操作:必须先 --dry-run 预览(官方服务端校验),人工确认后另起命令 --confirm 执行',
  mutation: 'reversible',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'sku', desc: '本店铺要修改的 SKU(必填)', required: true },
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
    parsePatches(flags); // 提前校验 JSON 结构,坏参数不消耗 API 调用
  },
  describe: (flags) => {
    const patches = parsePatches(flags);
    const attrs = touchedAttributes(patches);
    return (
      `修改 ${strFlag(flags, 'marketplace')?.toUpperCase()} 站点 SKU「${strFlag(flags, 'sku')}」的 listing:` +
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
  dryRun: async (ctx) => {
    const patches = parsePatches(ctx.flags);
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const sku = strFlag(ctx.flags, 'sku')!;

    // 沙盒模式:静态沙盒只匹配预定义参数,拉当前值一步没有对应 mock,
    // 跳过它直接验证 VALIDATION_PREVIEW 链路(沙盒专用 SKU:VALIDATION_VALID / VALIDATION_INVALID)
    if (isSandboxMode()) {
      ctx.progress('· [沙盒 dry-run] 跳过当前值拉取,直接调 VALIDATION_PREVIEW...');
      const validation = await callPatch(ctx, { validationPreview: true });
      assertValidationPassed(validation);
      return {
        sku,
        marketplace: mkt.country,
        sandbox: true,
        proposed_patches: patches,
        validation,
      };
    }

    // 规格 §8.2 rule 3:必须先拉当前状态做对照,不能盲改
    ctx.progress('· [dry-run 1/2] 拉取当前 listing 值做对照...');
    const attrs = touchedAttributes(patches);
    const current = (await ctx.client.get(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
      { marketplaceIds: mkt.id, includedData: 'summaries,attributes' },
      mkt.region,
    )) as { attributes?: Record<string, unknown>; summaries?: unknown };

    const currentTouched: Record<string, unknown> = {};
    for (const name of attrs) {
      currentTouched[name] = current.attributes?.[name] ?? '(当前无此属性)';
    }

    ctx.progress('· [dry-run 2/2] 调用官方 VALIDATION_PREVIEW 服务端校验(不落库)...');
    const validation = await callPatch(ctx, { validationPreview: true });
    assertValidationPassed(validation);

    return {
      sku,
      marketplace: mkt.country,
      changes: {
        current_values: currentTouched,
        proposed_patches: patches,
      },
      validation,
      next:
        '人工核对以上"当前值 → 改动"无误后,使用输出 meta.preview_token，' +
        '以完全相同的业务参数加 --confirm --preview-token <令牌> 执行',
    };
  },
  execute: async (ctx) => {
    ctx.progress('· 正在提交 listing 修改...');
    const confirmedPatches = Array.isArray(ctx.confirmedInput)
      ? (ctx.confirmedInput as JsonPatch[])
      : undefined;
    const result = await callPatch(ctx, {
      validationPreview: false,
      patches: confirmedPatches,
    });
    return result;
  },
};
