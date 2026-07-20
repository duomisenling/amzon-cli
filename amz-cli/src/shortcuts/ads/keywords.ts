// ads keywords / keyword-bid / negative-keyword —— 广告关键词层操作
//
// 依据(2026-07-14 官方 Postman 集合逐字核实):
//   POST /sp/keywords/list        列关键词(campaignIdFilter/keywordIdFilter/stateFilter/maxResults)
//   PUT  /sp/keywords             调关键词(body {keywords:[{keywordId, bid, state?}]})
//   POST /sp/negativeKeywords     加否定词(body {negativeKeywords:[{campaignId, adGroupId,
//                                   matchType: NEGATIVE_EXACT(官方示例)|NEGATIVE_PHRASE, state, keywordText}]})
//
// 典型优化循环:ads report-run --type search-terms 找废词
//            → ads negative-keyword 否掉 / ads keyword-bid 降竞价

import { AmzError } from '../../internal/errs/errors.js';
import { AdsClient, ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag, validateNumberFlag } from '../common.js';
import {
  ADS_REGION_FLAG,
  adsRegion,
  assertAdsWriteAccepted,
  assertChangeNeeded,
  recordFromContext,
  requirePositiveAmount,
  requireProfileId,
  verifyAfterWrite,
} from './common.js';

export async function fetchKeyword(
  client: AdsClient,
  profileId: string,
  keywordId: string,
  region?: 'na' | 'eu' | 'fe',
): Promise<Record<string, unknown> | undefined> {
  const resp = (await client.request('POST', '/sp/keywords/list', {
    profileId,
    region,
    contentType: ADS_CONTENT_TYPES.spKeyword,
    retry5xx: true,
    body: { keywordIdFilter: { include: [keywordId] } },
  })) as { keywords?: Array<Record<string, unknown>> } | null;
  return resp?.keywords?.[0];
}

// —— 读:列关键词 ——
export const adsKeywords: ToolDefinition = {
  service: 'ads',
  command: 'keywords',
  description: '列出投放的关键词(词/匹配方式/竞价/状态;可按广告活动过滤)',
  mutation: 'none',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'campaign-id', desc: '按广告活动过滤(可选)' },
    { name: 'state', desc: '按状态过滤(可选)', enum: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
    { name: 'max', desc: '最多返回条数,默认 100' },
    { name: 'next-token', desc: '分页游标(上一页返回的 nextToken)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    validateNumberFlag(flags, 'max', '--max', { min: 1, max: 100, integer: true });
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const campaignId = strFlag(ctx.flags, 'campaignId');
    const state = strFlag(ctx.flags, 'state');

    ctx.progress('· 正在查询关键词列表...');
    const resp = (await ctx.adsClient.request('POST', '/sp/keywords/list', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spKeyword,
      retry5xx: true,
      body: {
        maxResults: Number(strFlag(ctx.flags, 'max') ?? 100),
        ...(strFlag(ctx.flags, 'nextToken') ? { nextToken: strFlag(ctx.flags, 'nextToken') } : {}),
        ...(campaignId ? { campaignIdFilter: { include: [campaignId] } } : {}),
        ...(state ? { stateFilter: { include: [state] } } : {}),
      },
    })) as { keywords?: Array<Record<string, unknown>>; nextToken?: string } | null;

    const keywords = (resp?.keywords ?? []).map((k) => ({
      keywordId: k['keywordId'],
      text: k['keywordText'],
      matchType: k['matchType'],
      bid: k['bid'],
      state: k['state'],
      campaignId: k['campaignId'],
      adGroupId: k['adGroupId'],
    }));
    return { profileId, count: keywords.length, keywords, ...(resp?.nextToken ? { nextToken: resp.nextToken } : {}) };
  },
};

// —— 写:调关键词竞价 ——
export const adsKeywordBid: ToolDefinition = {
  service: 'ads',
  command: 'keyword-bid',
  description: '调整关键词竞价。写操作:--dry-run 显示当前→新竞价对照,人工终端 --confirm 执行',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'keyword-id', desc: '关键词 ID(必填,ads keywords 可查)', required: true },
    { name: 'bid', desc: '新竞价,数字,账户币种(必填)', required: true },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    requirePositiveAmount(flags, 'bid', '--bid');
  },
  describe: (flags) =>
    `将关键词 ${strFlag(flags, 'keywordId')} 的竞价改为 ${strFlag(flags, 'bid')}(账户币种)`,
  confirmationStateSnapshot: async (ctx) => {
    const current = await fetchKeyword(
      ctx.adsClient,
      requireProfileId(ctx.flags),
      strFlag(ctx.flags, 'keywordId')!,
      adsRegion(ctx.flags),
    );
    if (!current) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.keyword_not_found',
        param: '--keyword-id',
        hintAgent: 'fix_param',
        hintHuman: '没有找到关键词，请用 ads keywords 核对。',
        message: 'keyword not found while capturing confirmation state',
      });
    }
    return current;
  },
  dryRun: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const keywordId = strFlag(ctx.flags, 'keywordId')!;

    ctx.progress('· 已查询当前竞价做对照...');
    const current = recordFromContext(ctx.confirmationState);
    if (!current) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.keyword_not_found',
        param: '--keyword-id',
        hintAgent: 'fix_param',
        hintHuman: `没有找到关键词 ${keywordId},请用 ads keywords 核对。`,
        message: `keyword ${keywordId} not found`,
      });
    }
    const newBid = requirePositiveAmount(ctx.flags, 'bid', '--bid');
    assertChangeNeeded(Number(current['bid']), newBid, '关键词竞价');
    return {
      dry_run_note: '请人工核对以下竞价改动;确认后凭本次预览令牌执行正式写入。',
      keyword: { id: keywordId, text: current['keywordText'], matchType: current['matchType'], state: current['state'] },
      change: { current_bid: current['bid'], new_bid: newBid },
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const keywordId = strFlag(ctx.flags, 'keywordId')!;
    const newBid = requirePositiveAmount(ctx.flags, 'bid', '--bid');
    ctx.progress('· 正在修改关键词竞价...');
    const resp = await ctx.adsClient.request('PUT', '/sp/keywords', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spKeyword,
      body: {
        keywords: [{ keywordId, bid: newBid }],
      },
      extraHeaders: { Prefer: 'return=representation' },
    });
    assertAdsWriteAccepted(resp, 'keywords', '竞价修改');
    const verification = await verifyAfterWrite(
      () => fetchKeyword(ctx.adsClient, profileId, keywordId, adsRegion(ctx.flags)),
      (record) => Number(record['bid']) === newBid,
      '即时回读未确认新竞价。不要自动重试写入，请稍后只读查询或到广告后台核对。',
    );
    return { result: resp, ...verification };
  },
};

// —— 写:添加否定关键词 ——
export const adsNegativeKeyword: ToolDefinition = {
  service: 'ads',
  command: 'negative-keyword',
  description: '给广告组添加否定关键词(该词不再触发你的广告,省废流量的钱)。写操作,--dry-run → --confirm',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'campaign-id', desc: '广告活动 ID(必填)', required: true },
    { name: 'ad-group-id', desc: '广告组 ID(必填,ads keywords 结果里有)', required: true },
    { name: 'text', desc: '要否定的词(必填)', required: true },
    {
      name: 'match',
      desc: '否定匹配方式,默认 NEGATIVE_EXACT(精准否定);NEGATIVE_PHRASE 为词组否定,范围更大',
      enum: ['NEGATIVE_EXACT', 'NEGATIVE_PHRASE'],
    },
  ],
  validate: (flags) => {
    requireProfileId(flags);
  },
  describe: (flags) =>
    `在广告活动 ${strFlag(flags, 'campaignId')} / 广告组 ${strFlag(flags, 'adGroupId')} ` +
    `添加否定词「${strFlag(flags, 'text')}」(${strFlag(flags, 'match') === 'NEGATIVE_PHRASE' ? '词组否定' : '精准否定'})` +
    `——此后这个搜索词不再触发该广告组的广告`,
  dryRun: async (ctx) => {
    return {
      dry_run_note: '请人工核对以下否定词;确认后凭本次预览令牌执行正式写入。',
      endpoint: 'POST /sp/negativeKeywords',
      payload: buildNegativeKeywordBody(ctx.flags),
      effect: `搜索词「${strFlag(ctx.flags, 'text')}」将不再触发该广告组的广告(否定词可随时在后台暂停/删除,可逆)`,
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    ctx.progress('· 正在添加否定关键词...');
    const resp = await ctx.adsClient.request('POST', '/sp/negativeKeywords', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spNegativeKeyword,
      body: buildNegativeKeywordBody(ctx.flags),
      extraHeaders: { Prefer: 'return=representation' },
    });
    assertAdsWriteAccepted(resp, 'negativeKeywords', '否定词创建');
    return {
      result: resp,
      verificationStatus: 'SERVER_RESPONSE_ONLY',
      note:
        '已返回 Amazon Ads 的创建响应。当前 CLI 未实现官方 negativeKeywords list 回读；' +
        '如响应结构不含成功 ID，请到广告后台核对，不能自动重试创建。',
    };
  },
};

/** dry-run 与 execute 用同一份 payload(预览即所提交)。 */
function buildNegativeKeywordBody(flags: Record<string, unknown>): Record<string, unknown> {
  return {
    negativeKeywords: [
      {
        campaignId: strFlag(flags, 'campaignId'),
        adGroupId: strFlag(flags, 'adGroupId'),
        keywordText: strFlag(flags, 'text'),
        matchType: strFlag(flags, 'match') ?? 'NEGATIVE_EXACT',
        state: 'ENABLED',
      },
    ],
  };
}
