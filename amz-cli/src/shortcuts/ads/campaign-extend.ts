// ads campaign-extend —— 向已有 Sponsored Products Campaign/广告组追加商品广告和正向关键词。
//
// 安全边界：
//   - 只操作明确给出的现有 campaignId + adGroupId，不创建 Campaign/广告组；
//   - 商品写入只接受已经解析并核实属于当前店铺/站点的 SKU；
//   - 预览和执行前都回读远端，只提交尚不存在的商品/关键词；
//   - 不修改 Campaign/广告组状态、预算或已有关键词竞价；
//   - 部分成功或结果不明时停止，重新预览会根据远端现状只显示剩余缺项。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ADS_CONTENT_TYPES, type AdsClient } from '../../internal/client/ads-client.js';
import type { SpApiClient } from '../../internal/client/client.js';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { assertAdsWriteAccepted } from './common.js';
import { preflightCampaignProducts } from './keyword-campaign-launch.js';

const positiveMoney = z.number().finite().positive();
const productSchema = z.object({
  sku: z.string().trim().min(1),
  asin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/).optional(),
});
const keywordSchema = z.object({
  text: z.string().trim().min(1).max(80),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']),
  bid: positiveMoney,
});

export const campaignExtensionPlanSchema = z
  .object({
    version: z.literal(1),
    profileId: z.string().regex(/^\d+$/),
    region: z.enum(['na', 'eu', 'fe']),
    marketplace: z.string().trim().min(2),
    campaignId: z.string().regex(/^\d+$/),
    adGroupId: z.string().regex(/^\d+$/),
    products: z.array(productSchema).max(20).default([]),
    keywords: z.array(keywordSchema).max(1000).default([]),
  })
  .superRefine((plan, ctx) => {
    if (plan.products.length === 0 && plan.keywords.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['products'],
        message: 'at least one product or keyword is required',
      });
    }
    const products = new Set<string>();
    plan.products.forEach((product, index) => {
      if (products.has(product.sku)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['products', index], message: 'duplicate SKU' });
      }
      products.add(product.sku);
    });
    const keywords = new Set<string>();
    plan.keywords.forEach((keyword, index) => {
      const key = keywordKey(keyword.text, keyword.matchType);
      if (keywords.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keywords', index],
          message: 'duplicate keyword text and matchType',
        });
      }
      keywords.add(key);
    });
  });

export type CampaignExtensionPlan = z.infer<typeof campaignExtensionPlanSchema>;

interface ExtensionState {
  productPreflight: {
    marketplace: string;
    verifiedProducts: Array<{ sku: string; asin?: string }>;
  };
  campaign: Record<string, unknown>;
  adGroup: Record<string, unknown>;
  existingProducts: Array<Record<string, unknown>>;
  existingKeywords: Array<Record<string, unknown>>;
  productsToCreate: Array<{ sku: string; asin?: string }>;
  keywordsToCreate: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bid: number }>;
}

function keywordKey(text: string, matchType: string): string {
  return `${text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')}\u0000${matchType.toUpperCase()}`;
}

function invalidTarget(subtype: string, hintHuman: string, message: string, param?: string): AmzError {
  return new AmzError({
    type: 'invalid_param',
    subtype,
    ...(param ? { param } : {}),
    hintAgent: 'fix_param',
    hintHuman,
    message,
  });
}

function parsePlan(value: unknown): CampaignExtensionPlan {
  let parsedValue = value;
  if (typeof value === 'string') {
    try {
      parsedValue = JSON.parse(value);
    } catch (error) {
      throw invalidTarget(
        'ads.invalid_campaign_extension_plan',
        '广告追加方案不是合法 JSON，请重新生成方案后预览。',
        `invalid campaign extension JSON: ${error instanceof Error ? error.message : String(error)}`,
        '--plan',
      );
    }
  }
  const parsed = campaignExtensionPlanSchema.safeParse(parsedValue);
  if (!parsed.success) {
    throw invalidTarget(
      'ads.invalid_campaign_extension_plan',
      '广告追加方案字段不完整或格式错误；商品必须使用本店 SKU，且至少提供一个商品或关键词。',
      `invalid campaign extension plan: ${parsed.error.message}`,
      '--plan',
    );
  }
  return parsed.data;
}

function readPlan(flags: Record<string, unknown>): { raw: string; plan: CampaignExtensionPlan } {
  const ref = strFlag(flags, 'plan');
  if (!ref) {
    throw invalidTarget('ads.missing_campaign_extension_plan', '请用 --plan 提供广告追加方案 JSON 文件。', '--plan is required', '--plan');
  }
  let raw: string;
  if (ref.trimStart().startsWith('{')) {
    raw = ref;
  } else {
    try {
      raw = readFileSync(ref, 'utf8');
    } catch (error) {
      throw invalidTarget(
        'ads.campaign_extension_plan_unreadable',
        `读取不到广告追加方案文件“${ref}”，请检查路径。`,
        `cannot read campaign extension plan: ${error instanceof Error ? error.message : String(error)}`,
        '--plan',
      );
    }
  }
  return { raw, plan: parsePlan(raw) };
}

function planFromContext(ctx: ToolContext): CampaignExtensionPlan {
  return ctx.confirmedInput ? (ctx.confirmedInput as CampaignExtensionPlan) : readPlan(ctx.flags).plan;
}

export function campaignExtensionPlanHash(plan: CampaignExtensionPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

async function listAll(
  client: AdsClient,
  plan: CampaignExtensionPlan,
  path: string,
  contentType: string,
  group: 'productAds' | 'keywords',
): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const response = (await client.request('POST', path, {
      profileId: plan.profileId,
      region: plan.region,
      contentType,
      retry5xx: true,
      body: {
        campaignIdFilter: { include: [plan.campaignId] },
        adGroupIdFilter: { include: [plan.adGroupId] },
        maxResults: 100,
        ...(nextToken ? { nextToken } : {}),
      },
    })) as Record<string, unknown> | null;
    const pageRecords = response?.[group];
    if (Array.isArray(pageRecords)) {
      records.push(...pageRecords.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)));
    }
    nextToken = typeof response?.['nextToken'] === 'string' && response['nextToken'] ? response['nextToken'] : undefined;
    if (!nextToken) return records;
  }
  throw new AmzError({
    type: 'upstream_error',
    subtype: 'ads.campaign_extension_pagination_limit',
    hintAgent: 'report_to_human',
    hintHuman: '读取已有广告内容时分页超过安全上限，已停止操作，未执行写入。',
    message: `campaign extension ${group} pagination exceeded 100 pages`,
  });
}

export async function captureCampaignExtensionState(
  adsClient: AdsClient,
  spClient: SpApiClient,
  plan: CampaignExtensionPlan,
): Promise<ExtensionState> {
  const productPreflight = await preflightCampaignProducts(spClient, plan);
  const common = { profileId: plan.profileId, region: plan.region } as const;
  const campaignResponse = (await adsClient.request('POST', '/sp/campaigns/list', {
    ...common,
    contentType: ADS_CONTENT_TYPES.spCampaign,
    retry5xx: true,
    body: { campaignIdFilter: { include: [plan.campaignId] }, maxResults: 1 },
  })) as { campaigns?: Array<Record<string, unknown>> } | null;
  const campaign = campaignResponse?.campaigns?.find((item) => String(item['campaignId']) === plan.campaignId);
  if (!campaign) {
    throw invalidTarget(
      'ads.campaign_extension_campaign_not_found',
      `在广告账户 ${plan.profileId} 中找不到 Campaign ${plan.campaignId}，请重新查询确认。`,
      `campaign ${plan.campaignId} not found in profile ${plan.profileId}`,
      'campaignId',
    );
  }
  if (String(campaign['state']).toUpperCase() === 'ARCHIVED') {
    throw invalidTarget(
      'ads.campaign_extension_campaign_archived',
      '目标 Campaign 已归档，不能继续追加商品或关键词。',
      `campaign ${plan.campaignId} is archived`,
      'campaignId',
    );
  }
  if (plan.keywords.length > 0 && String(campaign['targetingType']).toUpperCase() !== 'MANUAL') {
    throw invalidTarget(
      'ads.campaign_extension_requires_manual_campaign',
      '正向关键词只能追加到手动投放 Campaign；当前目标不是 MANUAL，请重新选择。',
      `campaign ${plan.campaignId} targetingType is ${String(campaign['targetingType'])}`,
      'campaignId',
    );
  }

  const adGroupResponse = (await adsClient.request('POST', '/sp/adGroups/list', {
    ...common,
    contentType: ADS_CONTENT_TYPES.spAdGroup,
    retry5xx: true,
    body: { adGroupIdFilter: { include: [plan.adGroupId] }, maxResults: 1 },
  })) as { adGroups?: Array<Record<string, unknown>> } | null;
  const adGroup = adGroupResponse?.adGroups?.find((item) => String(item['adGroupId']) === plan.adGroupId);
  if (!adGroup || String(adGroup['campaignId']) !== plan.campaignId) {
    throw invalidTarget(
      'ads.campaign_extension_ad_group_mismatch',
      `广告组 ${plan.adGroupId} 不属于 Campaign ${plan.campaignId}，已停止写入。`,
      `ad group ${plan.adGroupId} does not belong to campaign ${plan.campaignId}`,
      'adGroupId',
    );
  }
  if (String(adGroup['state']).toUpperCase() === 'ARCHIVED') {
    throw invalidTarget(
      'ads.campaign_extension_ad_group_archived',
      '目标广告组已归档，不能继续追加商品或关键词。',
      `ad group ${plan.adGroupId} is archived`,
      'adGroupId',
    );
  }

  const [allProductAds, allKeywords] = await Promise.all([
    plan.products.length > 0
      ? listAll(adsClient, plan, '/sp/productAds/list', ADS_CONTENT_TYPES.spProductAd, 'productAds')
      : Promise.resolve([]),
    plan.keywords.length > 0
      ? listAll(adsClient, plan, '/sp/keywords/list', ADS_CONTENT_TYPES.spKeyword, 'keywords')
      : Promise.resolve([]),
  ]);
  const requestedSkus = new Set(plan.products.map((product) => product.sku));
  const requestedKeywordKeys = new Set(plan.keywords.map((keyword) => keywordKey(keyword.text, keyword.matchType)));
  const existingProducts = allProductAds.filter(
    (item) =>
      String(item['campaignId']) === plan.campaignId &&
      String(item['adGroupId']) === plan.adGroupId &&
      requestedSkus.has(String(item['sku'])),
  );
  const existingKeywords = allKeywords.filter(
    (item) =>
      String(item['campaignId']) === plan.campaignId &&
      String(item['adGroupId']) === plan.adGroupId &&
      requestedKeywordKeys.has(keywordKey(String(item['keywordText'] ?? ''), String(item['matchType'] ?? ''))),
  );
  const existingSkus = new Set(existingProducts.map((item) => String(item['sku'])));
  const existingKeywordKeys = new Set(
    existingKeywords.map((item) => keywordKey(String(item['keywordText'] ?? ''), String(item['matchType'] ?? ''))),
  );
  return {
    productPreflight,
    campaign,
    adGroup,
    existingProducts,
    existingKeywords,
    productsToCreate: plan.products.filter((product) => !existingSkus.has(product.sku)),
    keywordsToCreate: plan.keywords.filter(
      (keyword) => !existingKeywordKeys.has(keywordKey(keyword.text, keyword.matchType)),
    ),
  };
}

function stateFromContext(value: unknown): ExtensionState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as Partial<ExtensionState>;
  return Array.isArray(state.productsToCreate) && Array.isArray(state.keywordsToCreate)
    ? (state as ExtensionState)
    : undefined;
}

function preview(plan: CampaignExtensionPlan, state: ExtensionState): Record<string, unknown> {
  if (state.productsToCreate.length === 0 && state.keywordsToCreate.length === 0) {
    throw invalidTarget(
      'ads.campaign_extension_no_change',
      '计划中的商品和关键词都已经存在，无需再次写入，也不会签发审批令牌。',
      'campaign extension is a no-op',
    );
  }
  const campaignState = String(state.campaign['state'] ?? 'UNKNOWN');
  return {
    dry_run_note: '当前只是预览，尚未写入。正式执行只会创建下列缺少项，不修改活动预算、活动状态或已有竞价。',
    marketplace: state.productPreflight.marketplace,
    profileId: plan.profileId,
    campaign: {
      campaignId: plan.campaignId,
      name: state.campaign['name'],
      state: campaignState,
      targetingType: state.campaign['targetingType'],
    },
    adGroup: {
      adGroupId: plan.adGroupId,
      name: state.adGroup['name'],
      state: state.adGroup['state'],
    },
    verifiedProducts: state.productPreflight.verifiedProducts,
    alreadyExistingProducts: state.existingProducts.map((item) => ({ sku: item['sku'], adId: item['adId'], state: item['state'] })),
    productsToCreate: state.productsToCreate,
    alreadyExistingKeywords: state.existingKeywords.map((item) => ({
      text: item['keywordText'],
      matchType: item['matchType'],
      bid: item['bid'],
      keywordId: item['keywordId'],
      state: item['state'],
    })),
    keywordsToCreate: state.keywordsToCreate,
    preserves: ['Campaign 状态', 'Campaign 预算', '广告组状态', '所有已有商品广告', '所有已有关键词及竞价'],
    warning:
      campaignState.toUpperCase() === 'ENABLED'
        ? '⚠️ 目标 Campaign 当前已启用；新增商品和关键词成功后可能立即参与投放并产生花费。'
        : '目标 Campaign 当前未启用；本操作不会改变它的状态。',
    planHash: campaignExtensionPlanHash(plan),
  };
}

export async function executeCampaignExtension(
  adsClient: AdsClient,
  spClient: SpApiClient,
  plan: CampaignExtensionPlan,
  frozenState?: ExtensionState,
  progress: (message: string) => void = () => {},
): Promise<Record<string, unknown>> {
  const state = frozenState ?? (await captureCampaignExtensionState(adsClient, spClient, plan));
  if (state.productsToCreate.length === 0 && state.keywordsToCreate.length === 0) {
    return { alreadyComplete: true, campaignId: plan.campaignId, adGroupId: plan.adGroupId, verificationStatus: 'VERIFIED' };
  }

  if (state.productsToCreate.length > 0) {
    progress(`· 正在向已有广告组追加 ${state.productsToCreate.length} 个商品 SKU...`);
    const response = await adsClient.request('POST', '/sp/productAds', {
      profileId: plan.profileId,
      region: plan.region,
      contentType: ADS_CONTENT_TYPES.spProductAd,
      body: {
        productAds: state.productsToCreate.map((product) => ({
          campaignId: plan.campaignId,
          adGroupId: plan.adGroupId,
          sku: product.sku,
          state: 'ENABLED',
        })),
      },
      extraHeaders: { Prefer: 'return=representation' },
    });
    assertAdsWriteAccepted(response, 'productAds', '向已有广告组追加商品广告', state.productsToCreate.length);
  }

  for (let start = 0; start < state.keywordsToCreate.length; start += 100) {
    const chunk = state.keywordsToCreate.slice(start, start + 100);
    progress(`· 正在向已有广告组追加关键词 ${start + 1}-${start + chunk.length}/${state.keywordsToCreate.length}...`);
    const response = await adsClient.request('POST', '/sp/keywords', {
      profileId: plan.profileId,
      region: plan.region,
      contentType: ADS_CONTENT_TYPES.spKeyword,
      body: {
        keywords: chunk.map((keyword) => ({
          campaignId: plan.campaignId,
          adGroupId: plan.adGroupId,
          keywordText: keyword.text,
          matchType: keyword.matchType,
          bid: keyword.bid,
          state: 'ENABLED',
        })),
      },
      extraHeaders: { Prefer: 'return=representation' },
    });
    assertAdsWriteAccepted(response, 'keywords', '向已有广告组追加关键词', chunk.length);
  }

  progress('· 正在回读并核对追加结果...');
  const readback = await captureCampaignExtensionState(adsClient, spClient, plan);
  const verified = readback.productsToCreate.length === 0 && readback.keywordsToCreate.length === 0;
  if (!verified) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'ads.campaign_extension_verification_failed',
      hintAgent: 'report_to_human',
      hintHuman:
        '追加请求已经提交，但回读仍发现缺项。不要自动重放写入；请重新预览，系统会根据远端现状只列出仍缺少的商品或关键词。',
      message: `campaign extension readback missing products=${readback.productsToCreate.length} keywords=${readback.keywordsToCreate.length}`,
    });
  }
  return {
    campaignId: plan.campaignId,
    adGroupId: plan.adGroupId,
    campaignState: readback.campaign['state'],
    createdProductCount: state.productsToCreate.length,
    createdKeywordCount: state.keywordsToCreate.length,
    verificationStatus: 'VERIFIED',
    readback: {
      productAds: readback.existingProducts,
      keywords: readback.existingKeywords,
    },
    note: '已确认缺少项存在于目标广告组；Campaign 状态和预算均未修改。',
  };
}

export const adsCampaignExtend: ToolDefinition = {
  service: 'ads',
  command: 'campaign-extend',
  description:
    '向已有 SP Campaign/广告组追加多个 SKU 商品广告和正向关键词；只创建缺项，不改预算或状态。写操作：--dry-run → --confirm。',
  // 当前 CLI 没有归档新增商品广告/关键词的反向命令，按不可逆写入使用更严格的确认门槛。
  mutation: 'irreversible',
  flags: [{ name: 'plan', desc: '广告追加方案 JSON 文件路径(必填)', required: true }],
  validate: (flags) => {
    readPlan(flags);
  },
  describe: (flags) => {
    const plan = readPlan(flags).plan;
    return `向 Campaign ${plan.campaignId} / 广告组 ${plan.adGroupId} 追加 ${plan.products.length} 个 SKU 和 ${plan.keywords.length} 个关键词；不修改活动状态或预算`;
  },
  confirmationInput: (flags) => {
    const { raw, plan } = readPlan(flags);
    return {
      snapshot: { contentHash: createHash('sha256').update(raw).digest('hex'), planHash: campaignExtensionPlanHash(plan) },
      input: plan,
    };
  },
  confirmationStateSnapshot: async (ctx) => {
    const plan = planFromContext(ctx);
    return captureCampaignExtensionState(ctx.adsClient, ctx.client, plan);
  },
  dryRun: async (ctx) => {
    const plan = planFromContext(ctx);
    const state = stateFromContext(ctx.confirmationState) ?? (await captureCampaignExtensionState(ctx.adsClient, ctx.client, plan));
    return preview(plan, state);
  },
  execute: async (ctx) => {
    const plan = planFromContext(ctx);
    return executeCampaignExtension(ctx.adsClient, ctx.client, plan, stateFromContext(ctx.confirmationState), ctx.progress);
  },
};
