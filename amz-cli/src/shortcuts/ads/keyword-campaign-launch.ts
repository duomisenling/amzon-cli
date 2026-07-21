// ads keyword-campaign-launch —— 从不可变 JSON 方案创建完整 SP 手动关键词广告。
//
// 官方接口（Amazon Ads API v3）：
//   POST /sp/campaigns -> POST /sp/adGroups -> POST /sp/productAds
//   -> POST /sp/keywords -> 只读回查 -> PUT /sp/campaigns 启用。
// 所有子对象创建完成并回查成功前，Campaign 始终为 PAUSED。

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ADS_CONTENT_TYPES, type AdsClient } from '../../internal/client/ads-client.js';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { setCampaignState } from './campaign-state.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must use YYYY-MM-DD');
const positiveMoney = z.number().finite().positive();

const keywordSchema = z.object({
  text: z.string().trim().min(1).max(80),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']),
  bid: positiveMoney,
});

const productSchema = z
  .object({
    asin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/).optional(),
    sku: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.asin) === Boolean(value.sku)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide exactly one of asin or sku' });
    }
  });

/** 兼容旧方案:单个 product 归一为 products 数组,业务代码只处理数组一种形态。 */
function normalizeLegacyProduct(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record['products'] === undefined && record['product'] !== undefined) {
      const { product, ...rest } = record;
      return { ...rest, products: [product] };
    }
  }
  return value;
}

const keywordCampaignPlanObject = z
  .object({
    version: z.literal(1),
    launchId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    profileId: z.string().regex(/^\d+$/),
    region: z.enum(['na', 'eu', 'fe']),
    campaign: z.object({
      name: z.string().trim().min(1).max(128),
      dailyBudget: positiveMoney,
      startDate: isoDate,
      endDate: isoDate.optional(),
      biddingStrategy: z.enum(['LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL']).default('LEGACY_FOR_SALES'),
    }),
    adGroup: z.object({
      name: z.string().trim().min(1).max(128),
      defaultBid: positiveMoney,
    }),
    // 官方 POST /sp/productAds 本就接收数组;同一广告组的多商品(如变体)共享
    // 关键词与竞价。上限 20 是"预览必须可人工核对"的保守值,远低于接口上限。
    products: z.array(productSchema).min(1).max(20),
    keywords: z.array(keywordSchema).min(1).max(1000),
    enableAfterCreate: z.boolean(),
  })
  .superRefine((plan, ctx) => {
    if (!isRealDate(plan.campaign.startDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['campaign', 'startDate'], message: 'invalid calendar date' });
    }
    if (plan.campaign.endDate && !isRealDate(plan.campaign.endDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['campaign', 'endDate'], message: 'invalid calendar date' });
    }
    if (plan.campaign.endDate && plan.campaign.startDate > plan.campaign.endDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['campaign', 'endDate'], message: 'must not be before startDate' });
    }
    const seen = new Set<string>();
    plan.keywords.forEach((keyword, index) => {
      const key = `${normalizeKeyword(keyword.text)}\u0000${keyword.matchType}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keywords', index],
          message: 'duplicate keyword text and matchType',
        });
      }
      seen.add(key);
    });
    const seenProducts = new Set<string>();
    plan.products.forEach((product, index) => {
      const key = product.asin ? `asin:${product.asin}` : `sku:${product.sku}`;
      if (seenProducts.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['products', index], message: 'duplicate product' });
      }
      seenProducts.add(key);
    });
  });

export const keywordCampaignPlanSchema = z.preprocess(normalizeLegacyProduct, keywordCampaignPlanObject);

export type KeywordCampaignPlan = z.infer<typeof keywordCampaignPlanObject>;

type LaunchStatus =
  | 'PLANNED'
  | 'CAMPAIGN_CREATED'
  | 'ADGROUP_CREATED'
  | 'PRODUCT_AD_CREATED'
  | 'KEYWORDS_CREATED'
  | 'VERIFIED'
  | 'ENABLED'
  | 'PAUSED_COMPLETE'
  | 'PARTIAL_FAILURE'
  | 'RESULT_UNKNOWN';

interface LaunchJournal {
  version: 1;
  launchId: string;
  planHash: string;
  status: LaunchStatus;
  campaignId?: string;
  adGroupId?: string;
  /** 商品广告:方案 products 下标 → adId(多商品与关键词同构,支持断点续传) */
  adIds: Record<string, string>;
  completedProductIndexes: number[];
  keywordIds: Record<string, string>;
  completedKeywordIndexes: number[];
  lastError?: unknown;
  updatedAt: string;
}

interface BulkResult {
  success: Array<Record<string, unknown>>;
  error: Array<Record<string, unknown>>;
}

function isRealDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function normalizeKeyword(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function planPath(flags: Record<string, unknown>): string {
  const path = strFlag(flags, 'plan');
  if (!path) throw invalidPlan('--plan is required');
  return path;
}

function invalidPlan(detail: string): AmzError {
  return new AmzError({
    type: 'invalid_param',
    subtype: 'ads.invalid_keyword_campaign_plan',
    param: '--plan',
    hintAgent: 'fix_param',
    hintHuman: `广告方案无效：${detail}`,
    message: `invalid keyword campaign plan: ${detail}`,
  });
}

export function parseKeywordCampaignPlan(raw: string): KeywordCampaignPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalidPlan(`JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const result = keywordCampaignPlanSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidPlan(detail);
  }
  return result.data;
}

function readPlanFile(flags: Record<string, unknown>): { raw: string; plan: KeywordCampaignPlan } {
  const path = planPath(flags);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw invalidPlan(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  return { raw, plan: parseKeywordCampaignPlan(raw) };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function keywordCampaignPlanHash(plan: KeywordCampaignPlan): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(plan))).digest('hex');
}

function stateRoot(): string {
  return process.env['AMZ_CLI_STATE_DIR']?.trim() || join(homedir(), '.amz-cli');
}

function journalPath(plan: KeywordCampaignPlan): string {
  const safeName = createHash('sha256').update(plan.launchId).digest('hex');
  return join(stateRoot(), 'launches', `${safeName}.json`);
}

function newJournal(plan: KeywordCampaignPlan): LaunchJournal {
  return {
    version: 1,
    launchId: plan.launchId,
    planHash: keywordCampaignPlanHash(plan),
    status: 'PLANNED',
    adIds: {},
    completedProductIndexes: [],
    keywordIds: {},
    completedKeywordIndexes: [],
    updatedAt: new Date().toISOString(),
  };
}

function loadJournal(plan: KeywordCampaignPlan): LaunchJournal {
  const path = journalPath(plan);
  let journal: LaunchJournal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8')) as LaunchJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return newJournal(plan);
    throw error;
  }
  if (journal.version !== 1 || journal.launchId !== plan.launchId || journal.planHash !== keywordCampaignPlanHash(plan)) {
    throw invalidPlan('launchId 已被另一份不同内容的方案使用，请更换 launchId 并重新 dry-run');
  }
  // 多商品字段是后加的;防御性补默认值(旧单商品日志会先被上面的 planHash 拦下)
  journal.adIds ??= {};
  journal.completedProductIndexes ??= [];
  return journal;
}

function saveJournal(plan: KeywordCampaignPlan, journal: LaunchJournal): void {
  const path = journalPath(plan);
  mkdirSync(join(stateRoot(), 'launches'), { recursive: true, mode: 0o700 });
  journal.updatedAt = new Date().toISOString();
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(journal, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

function responseGroup(response: unknown, group: string): BulkResult {
  const root = response as Record<string, unknown> | null;
  const raw = root?.[group] as Record<string, unknown> | undefined;
  return {
    success: Array.isArray(raw?.['success']) ? (raw!['success'] as Array<Record<string, unknown>>) : [],
    error: Array.isArray(raw?.['error']) ? (raw!['error'] as Array<Record<string, unknown>>) : [],
  };
}

function idFrom(item: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = item[key];
    if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
    for (const nestedKey of ['campaign', 'adGroup', 'productAd', 'keyword']) {
      const nested = item[nestedKey] as Record<string, unknown> | undefined;
      const value = nested?.[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  return undefined;
}

function partialFailure(step: string, errors: unknown, successCount: number, expected: number): AmzError {
  const stateGuidance =
    step === '启用 Campaign'
      ? '启用响应未能完整确认，实际状态可能仍为暂停，也可能已经启用；请先查询核对，不能重复创建整套广告。'
      : 'Campaign 保持暂停。请检查返回的错误；不要重新创建整套广告，可在修正原因后使用同一方案继续。';
  return new AmzError({
    type: 'upstream_error',
    subtype: 'ads.keyword_campaign_partial_failure',
    hintAgent: 'report_to_human',
    hintHuman: `完整广告在“${step}”步骤只成功 ${successCount}/${expected}。${stateGuidance}`,
    message: `keyword campaign launch partial failure at ${step}: ${JSON.stringify(errors)}`,
  });
}

function markFailure(plan: KeywordCampaignPlan, journal: LaunchJournal, error: unknown): never {
  const ambiguous = error instanceof AmzError && error.subtype === 'ads.write_result_unknown';
  journal.status = ambiguous ? 'RESULT_UNKNOWN' : 'PARTIAL_FAILURE';
  journal.lastError = error instanceof AmzError ? error.toEnvelope() : String(error);
  saveJournal(plan, journal);
  throw error;
}

function campaignPayload(plan: KeywordCampaignPlan): Record<string, unknown> {
  return {
    campaigns: [
      {
        name: plan.campaign.name,
        targetingType: 'MANUAL',
        state: 'PAUSED',
        dynamicBidding: { strategy: plan.campaign.biddingStrategy },
        startDate: plan.campaign.startDate,
        ...(plan.campaign.endDate ? { endDate: plan.campaign.endDate } : {}),
        budget: { budgetType: 'DAILY', budget: plan.campaign.dailyBudget },
      },
    ],
  };
}

export function keywordCampaignPreview(plan: KeywordCampaignPlan): Record<string, unknown> {
  return {
    dry_run_note:
      '这是客户端预览，不会调用任何 Amazon 写接口。正式执行会先创建 PAUSED Campaign，' +
      '广告组、商品广告和全部关键词回查成功后才会按方案启用。',
    launchId: plan.launchId,
    profileId: plan.profileId,
    region: plan.region,
    campaign: campaignPayload(plan),
    adGroup: { name: plan.adGroup.name, defaultBid: plan.adGroup.defaultBid, state: 'ENABLED' },
    products: plan.products.map((product) => ({ ...product, state: 'ENABLED' })),
    productCount: plan.products.length,
    keywords: plan.keywords.map((keyword) => ({ ...keyword, state: 'ENABLED' })),
    keywordCount: plan.keywords.length,
    finalState: plan.enableAfterCreate ? 'ENABLED（仅在全部回查成功后）' : 'PAUSED',
    planHash: keywordCampaignPlanHash(plan),
  };
}

async function verifyCreatedObjects(client: AdsClient, plan: KeywordCampaignPlan, journal: LaunchJournal): Promise<void> {
  const common = { profileId: plan.profileId, region: plan.region } as const;
  const campaignResponse = (await client.request('POST', '/sp/campaigns/list', {
    ...common,
    contentType: ADS_CONTENT_TYPES.spCampaign,
    retry5xx: true,
    body: { campaignIdFilter: { include: [journal.campaignId] }, maxResults: 1 },
  })) as { campaigns?: Array<Record<string, unknown>> } | null;
  const adGroupResponse = (await client.request('POST', '/sp/adGroups/list', {
    ...common,
    contentType: ADS_CONTENT_TYPES.spAdGroup,
    retry5xx: true,
    body: { adGroupIdFilter: { include: [journal.adGroupId] }, maxResults: 1 },
  })) as { adGroups?: Array<Record<string, unknown>> } | null;
  const adIdEntries = Object.entries(journal.adIds);
  const productAdResponse = (await client.request('POST', '/sp/productAds/list', {
    ...common,
    contentType: ADS_CONTENT_TYPES.spProductAd,
    retry5xx: true,
    body: { adIdFilter: { include: adIdEntries.map(([, adId]) => adId) }, maxResults: adIdEntries.length },
  })) as { productAds?: Array<Record<string, unknown>> } | null;

  const keywordIds = Object.values(journal.keywordIds);
  const verifiedKeywordIds = new Set<string>();
  for (let start = 0; start < keywordIds.length; start += 100) {
    const ids = keywordIds.slice(start, start + 100);
    const keywordResponse = (await client.request('POST', '/sp/keywords/list', {
      ...common,
      contentType: ADS_CONTENT_TYPES.spKeyword,
      retry5xx: true,
      body: { keywordIdFilter: { include: ids }, maxResults: ids.length },
    })) as { keywords?: Array<Record<string, unknown>> } | null;
    for (const keyword of keywordResponse?.keywords ?? []) {
      const keywordId = keyword['keywordId'];
      if (
        (typeof keywordId === 'string' || typeof keywordId === 'number') &&
        String(keyword['campaignId']) === journal.campaignId &&
        String(keyword['adGroupId']) === journal.adGroupId
      ) {
        verifiedKeywordIds.add(String(keywordId));
      }
    }
  }

  const campaign = campaignResponse?.campaigns?.[0];
  const adGroup = adGroupResponse?.adGroups?.[0];
  // 逐条核对每个商品广告:adId 落在本 campaign/adGroup 下,且 asin/sku 与方案同下标商品一致
  const adsById = new Map(
    (productAdResponse?.productAds ?? []).map((ad) => [String(ad['adId']), ad]),
  );
  let verifiedProducts = 0;
  for (const [indexKey, adId] of adIdEntries) {
    const ad = adsById.get(String(adId));
    const product = plan.products[Number(indexKey)];
    if (
      ad &&
      product &&
      String(ad['campaignId']) === journal.campaignId &&
      String(ad['adGroupId']) === journal.adGroupId &&
      String(ad[product.asin ? 'asin' : 'sku']) === (product.asin ?? product.sku)
    ) {
      verifiedProducts += 1;
    }
  }
  const counts = {
    campaigns:
      campaign && String(campaign['campaignId']) === journal.campaignId && campaign['state'] === 'PAUSED' ? 1 : 0,
    adGroups:
      adGroup &&
      String(adGroup['adGroupId']) === journal.adGroupId &&
      String(adGroup['campaignId']) === journal.campaignId
        ? 1
        : 0,
    productAds: verifiedProducts,
    keywords: verifiedKeywordIds.size,
  };
  if (
    counts.campaigns !== 1 ||
    counts.adGroups !== 1 ||
    counts.productAds !== plan.products.length ||
    counts.keywords !== plan.keywords.length
  ) {
    throw partialFailure('回读验证', counts, counts.keywords, plan.keywords.length);
  }
}

export async function executeKeywordCampaignPlan(
  client: AdsClient,
  plan: KeywordCampaignPlan,
  progress: (message: string) => void = () => {},
): Promise<Record<string, unknown>> {
  const journal = loadJournal(plan);
  if (journal.status === 'RESULT_UNKNOWN') {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'ads.keyword_campaign_reconcile_required',
      hintAgent: 'report_to_human',
      hintHuman: '上次写请求结果不明确。为避免重复创建，CLI 已停止自动继续；请先在广告后台或只读接口核对。',
      message: `launch ${plan.launchId} has an ambiguous prior write and requires reconciliation`,
    });
  }
  if (journal.status === 'ENABLED' || journal.status === 'PAUSED_COMPLETE') {
    return { resumed: true, alreadyComplete: true, ...journal };
  }

  const requestOptions = { profileId: plan.profileId, region: plan.region } as const;
  try {
    if (!journal.campaignId) {
      progress('· [1/6] 创建暂停的 Campaign...');
      const response = await client.request('POST', '/sp/campaigns', {
        ...requestOptions,
        contentType: ADS_CONTENT_TYPES.spCampaign,
        body: campaignPayload(plan),
        extraHeaders: { Prefer: 'return=representation' },
      });
      const result = responseGroup(response, 'campaigns');
      const id = result.success[0] && idFrom(result.success[0], 'campaignId');
      if (id) {
        journal.campaignId = id;
        journal.status = 'CAMPAIGN_CREATED';
        saveJournal(plan, journal);
      }
      if (result.error.length || result.success.length !== 1 || !id) {
        throw partialFailure('创建 Campaign', result.error, result.success.length, 1);
      }
    }

    if (!journal.adGroupId) {
      progress('· [2/6] 创建广告组...');
      const response = await client.request('POST', '/sp/adGroups', {
        ...requestOptions,
        contentType: ADS_CONTENT_TYPES.spAdGroup,
        body: {
          adGroups: [{ campaignId: journal.campaignId, name: plan.adGroup.name, defaultBid: plan.adGroup.defaultBid, state: 'ENABLED' }],
        },
        extraHeaders: { Prefer: 'return=representation' },
      });
      const result = responseGroup(response, 'adGroups');
      const id = result.success[0] && idFrom(result.success[0], 'adGroupId');
      if (id) {
        journal.adGroupId = id;
        journal.status = 'ADGROUP_CREATED';
        saveJournal(plan, journal);
      }
      if (result.error.length || result.success.length !== 1 || !id) {
        throw partialFailure('创建广告组', result.error, result.success.length, 1);
      }
    }

    const completedProducts = new Set(journal.completedProductIndexes);
    const pendingProducts = plan.products
      .map((product, index) => ({ product, index }))
      .filter(({ index }) => !completedProducts.has(index));
    if (pendingProducts.length) {
      progress(`· [3/6] 创建 ${pendingProducts.length}/${plan.products.length} 条商品广告...`);
      const response = await client.request('POST', '/sp/productAds', {
        ...requestOptions,
        contentType: ADS_CONTENT_TYPES.spProductAd,
        body: {
          productAds: pendingProducts.map(({ product }) => ({
            campaignId: journal.campaignId,
            adGroupId: journal.adGroupId,
            ...product,
            state: 'ENABLED',
          })),
        },
        extraHeaders: { Prefer: 'return=representation' },
      });
      const result = responseGroup(response, 'productAds');
      for (const item of result.success) {
        const localIndex = Number(item['index']);
        const original = pendingProducts[localIndex];
        const id = idFrom(item, 'adId', 'productAdId');
        if (original && id) {
          completedProducts.add(original.index);
          journal.adIds[String(original.index)] = id;
        }
      }
      journal.completedProductIndexes = [...completedProducts].sort((a, b) => a - b);
      if (completedProducts.size) journal.status = 'PRODUCT_AD_CREATED';
      saveJournal(plan, journal);
      if (result.error.length || completedProducts.size !== plan.products.length) {
        throw partialFailure('创建商品广告', result.error, completedProducts.size, plan.products.length);
      }
    }

    const completed = new Set(journal.completedKeywordIndexes);
    for (let start = 0; start < plan.keywords.length; start += 100) {
      const pending = plan.keywords
        .map((keyword, index) => ({ keyword, index }))
        .slice(start, start + 100)
        .filter(({ index }) => !completed.has(index));
      if (!pending.length) continue;
      progress(`· [4/6] 创建关键词 ${pending[0]!.index + 1}-${pending[pending.length - 1]!.index + 1}/${plan.keywords.length}...`);
      const response = await client.request('POST', '/sp/keywords', {
        ...requestOptions,
        contentType: ADS_CONTENT_TYPES.spKeyword,
        body: {
          keywords: pending.map(({ keyword }) => ({
            campaignId: journal.campaignId,
            adGroupId: journal.adGroupId,
            keywordText: keyword.text,
            matchType: keyword.matchType,
            bid: keyword.bid,
            state: 'ENABLED',
          })),
        },
        extraHeaders: { Prefer: 'return=representation' },
      });
      const result = responseGroup(response, 'keywords');
      for (const item of result.success) {
        const localIndex = Number(item['index']);
        const original = pending[localIndex];
        const id = idFrom(item, 'keywordId');
        if (original && id) {
          completed.add(original.index);
          journal.keywordIds[String(original.index)] = id;
        }
      }
      journal.completedKeywordIndexes = [...completed].sort((a, b) => a - b);
      saveJournal(plan, journal);
      if (result.error.length || journal.completedKeywordIndexes.length < Math.min(start + 100, plan.keywords.length)) {
        throw partialFailure('创建关键词', result.error, journal.completedKeywordIndexes.length, plan.keywords.length);
      }
    }
    journal.status = 'KEYWORDS_CREATED';
    saveJournal(plan, journal);

    progress('· [5/6] 回读并核对完整广告结构...');
    await verifyCreatedObjects(client, plan, journal);
    journal.status = 'VERIFIED';
    saveJournal(plan, journal);

    if (plan.enableAfterCreate) {
      progress('· [6/6] 全部验证成功，启用 Campaign...');
      const enableResponse = await setCampaignState(client, plan.profileId, journal.campaignId!, 'ENABLED', plan.region);
      const enableResult = responseGroup(enableResponse, 'campaigns');
      if (enableResult.error.length || enableResult.success.length !== 1) {
        throw partialFailure('启用 Campaign', enableResult.error, enableResult.success.length, 1);
      }
      journal.status = 'ENABLED';
    } else {
      journal.status = 'PAUSED_COMPLETE';
    }
    saveJournal(plan, journal);
    return {
      launchId: plan.launchId,
      campaignId: journal.campaignId,
      adGroupId: journal.adGroupId,
      adIds: journal.adIds,
      productCount: plan.products.length,
      keywordIds: journal.keywordIds,
      keywordCount: plan.keywords.length,
      state: plan.enableAfterCreate ? 'ENABLED' : 'PAUSED',
      journalStatus: journal.status,
      // 暂停创建完成后,把"第二阶段开启"做成可操作指引:先列清再由用户单独决定是否开启。
      ...(plan.enableAfterCreate
        ? {}
        : {
            enabled: false,
            next:
              '整套广告已创建并保持【暂停】，不会产生花费。是否开启请作为独立第二步：' +
              '先把已创建的活动/广告组/商品/每个关键词与竞价逐条列给用户、说明"开启后立即投放花钱"，' +
              `确认后再单独启用：ads campaign-state --profile-id ${plan.profileId} --campaign-id ${journal.campaignId} --state ENABLED --dry-run`,
          }),
    };
  } catch (error) {
    return markFailure(plan, journal, error);
  }
}

function planFromContext(ctx: ToolContext): KeywordCampaignPlan {
  if (ctx.confirmedInput) return ctx.confirmedInput as KeywordCampaignPlan;
  return readPlanFile(ctx.flags).plan;
}

export const adsKeywordCampaignLaunch: ToolDefinition = {
  service: 'ads',
  command: 'keyword-campaign-launch',
  description: '从 JSON 方案创建完整 SP 手动关键词广告。必须先 --dry-run，确认后执行；完整回查前保持暂停',
  mutation: 'reversible',
  flags: [{ name: 'plan', desc: '完整关键词广告方案 JSON 文件路径（必填）', required: true }],
  validate: (flags) => {
    readPlanFile(flags);
  },
  describe: (flags) => {
    const plan = readPlanFile(flags).plan;
    const labels = plan.products.map((product) => product.asin ?? product.sku);
    const productSummary =
      labels.length <= 3 ? labels.join('、') : `${labels.slice(0, 3).join('、')} 等 ${labels.length} 个`;
    return `在 profile ${plan.profileId}/${plan.region} 创建“${plan.campaign.name}”，商品 ${productSummary}，` +
      `${plan.keywords.length} 个关键词，日预算 ${plan.campaign.dailyBudget}，最终${plan.enableAfterCreate ? '启用并开始投放' : '保持暂停'}`;
  },
  confirmationInput: (flags) => {
    const { raw, plan } = readPlanFile(flags);
    return {
      snapshot: { contentHash: createHash('sha256').update(raw).digest('hex'), planHash: keywordCampaignPlanHash(plan) },
      input: plan,
    };
  },
  dryRun: async (ctx) => keywordCampaignPreview(planFromContext(ctx)),
  execute: async (ctx) => executeKeywordCampaignPlan(ctx.adsClient, planFromContext(ctx), ctx.progress),
};
