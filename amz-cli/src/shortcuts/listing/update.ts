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
  op: string;
  path: string;
  value?: unknown;
}

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
  for (const p of parsed) {
    if (typeof p !== 'object' || p === null || !('op' in p) || !('path' in p)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_patch_op',
        param: '--patches',
        hintAgent: 'fix_param',
        hintHuman: '每个 patch 必须包含 op(如 replace)和 path(如 /attributes/...)。',
        message: `invalid patch item: ${JSON.stringify(p)}`,
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
  const sellerId = resolveSellerId(ctx.flags, mkt.region);
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
    { name: 'seller-id', desc: '卖家编号(可省略,默认读 .env 的 SELLER_ID)' },
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
  dryRun: async (ctx) => {
    const patches = parsePatches(ctx.flags);
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = resolveSellerId(ctx.flags, mkt.region);
    const sku = strFlag(ctx.flags, 'sku')!;

    // 沙盒模式:静态沙盒只匹配预定义参数,拉当前值一步没有对应 mock,
    // 跳过它直接验证 VALIDATION_PREVIEW 链路(沙盒专用 SKU:VALIDATION_VALID / VALIDATION_INVALID)
    if (isSandboxMode()) {
      ctx.progress('· [沙盒 dry-run] 跳过当前值拉取,直接调 VALIDATION_PREVIEW...');
      const validation = await callPatch(ctx, { validationPreview: true });
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
