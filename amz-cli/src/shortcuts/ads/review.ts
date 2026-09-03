// ads review —— 广告体检一条龙:活动清单 + 绩效汇总 + 废词 +(可选)聚焦某个 ASIN
//
// 背景:运营做"某个产品的广告该怎么调"时,Agent 要串行跑 campaigns / performance /
//   wasted-spend / report-run(advertised-products) 四五条命令,每张报表各等各的,
//   一轮分析要二三十分钟。这里收成一条命令:三张报表同时创建(亚马逊并行生成),
//   活动清单同步在拉,总耗时≈最慢的一张报表。
//
// 输出口径:CLI 只负责把数据取齐、汇总、标记(spendNoSales/废词),
//   "调整方向/是否新增广告"的判断留给下游 Agent 或人。
//
// 数据源:/sp/campaigns/list + V3 报表 spCampaigns / spSearchTerm / spAdvertisedProduct

import { ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { strFlag, validateNumberFlag } from '../common.js';
import {
  ADS_REGION_FLAG,
  adsRegion,
  requireDate,
  requireProfileId,
  validateReportWindow,
} from './common.js';
import { buildAdsPerfRows, filterAndSortAdsPerfRows } from './performance.js';
import type { AdsPerfRow } from './performance.js';
import { fetchAdsReportRows } from './report.js';
import { aggregateWastedSpend } from './wasted-spend.js';
import type { WastedTerm } from './wasted-spend.js';

/** 活动清单只留决策要用的字段,原始对象几十个字段全带上输出会爆。 */
export function trimCampaign(c: Record<string, unknown>): Record<string, unknown> {
  const budget = c['budget'] as Record<string, unknown> | undefined;
  return {
    campaignId: c['campaignId'],
    name: c['name'],
    state: c['state'],
    ...(budget?.['budget'] !== undefined ? { dailyBudget: budget['budget'] } : {}),
    ...(c['targetingSettings'] !== undefined ? { targeting: c['targetingSettings'] } : {}),
    ...(c['startDate'] !== undefined ? { startDate: c['startDate'] } : {}),
    ...(c['endDate'] !== undefined ? { endDate: c['endDate'] } : {}),
  };
}

/** 可选的广告商品报表结果:成功给 rows,失败给 error(不抛,避免拖垮主体数据)。 */
interface ProductReportResult {
  rows?: Array<Record<string, unknown>>;
  error?: string;
}

export interface AsinCampaignAgg {
  campaignId?: string;
  impressions: number;
  clicks: number;
  cost: number;
  orders: number;
  sales: number;
}

/**
 * 纯聚合:spAdvertisedProduct 天级明细 → 只留目标 ASIN 的行 → 按活动汇总。
 * 用来回答"这个 ASIN 由哪些活动在投、各花了多少"。
 */
export function aggregateAsinCampaigns(
  rows: Array<Record<string, unknown>>,
  asin: string,
): AsinCampaignAgg[] {
  const target = asin.trim().toUpperCase();
  const map = new Map<string, AsinCampaignAgg>();
  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  for (const row of rows) {
    const rowAsin = String(row['advertisedAsin'] ?? '').trim().toUpperCase();
    if (rowAsin !== target) continue;
    const campaignId = row['campaignId'] != null ? String(row['campaignId']) : undefined;
    const key = campaignId ?? '';
    let agg = map.get(key);
    if (!agg) {
      agg = { campaignId, impressions: 0, clicks: 0, cost: 0, orders: 0, sales: 0 };
      map.set(key, agg);
    }
    agg.impressions += n(row['impressions']);
    agg.clicks += n(row['clicks']);
    agg.cost += n(row['cost']);
    agg.orders += n(row['purchases7d'] ?? row['purchases']);
    agg.sales += n(row['sales7d'] ?? row['sales']);
  }
  return [...map.values()]
    .map((a) => ({ ...a, cost: Math.round(a.cost * 100) / 100, sales: Math.round(a.sales * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);
}

/** 全量绩效行上的账户级合计(过滤/聚焦之前算,避免被筛选口径误导)。 */
export function buildReviewTotals(all: AdsPerfRow[]): Record<string, unknown> {
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  const totalSpend = round2(all.reduce((s, r) => s + r.cost, 0));
  const totalSales = round2(all.reduce((s, r) => s + r.sales, 0));
  return {
    totalSpend,
    totalSales,
    totalOrders: all.reduce((s, r) => s + r.orders, 0),
    totalClicks: all.reduce((s, r) => s + r.clicks, 0),
    overallAcos: totalSales > 0 ? Math.round((totalSpend / totalSales) * 1000) / 10 : null,
    spendNoSalesCount: all.filter((r) => r.spendNoSales).length,
  };
}

function requireOptionalAsin(flags: Record<string, unknown>): string | undefined {
  const asin = strFlag(flags, 'asin');
  if (asin === undefined) return undefined;
  if (!/^[A-Za-z0-9]{10}$/.test(asin)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_asin',
      param: '--asin',
      hintAgent: 'fix_param',
      hintHuman: `--asin 应为 10 位字母数字(收到 "${asin}")。`,
      message: `invalid asin: ${asin}`,
    });
  }
  return asin.toUpperCase();
}

/** 拉全量活动清单(自动翻页,硬上限 10000 条防失控)。 */
async function listAllCampaigns(
  ctx: ToolContext,
  profileId: string,
): Promise<Array<Record<string, unknown>>> {
  const campaigns: Array<Record<string, unknown>> = [];
  let nextToken: string | undefined;
  for (;;) {
    const resp = (await ctx.adsClient.request('POST', '/sp/campaigns/list', {
      profileId,
      region: adsRegion(ctx.flags),
      contentType: ADS_CONTENT_TYPES.spCampaign,
      retry5xx: true,
      body: { maxResults: 100, ...(nextToken ? { nextToken } : {}) },
    })) as { campaigns?: Array<Record<string, unknown>>; nextToken?: string } | null;
    campaigns.push(...(resp?.campaigns ?? []));
    nextToken = resp?.nextToken;
    if (!nextToken || campaigns.length >= 10_000 || (resp?.campaigns?.length ?? 0) === 0) break;
  }
  return campaigns;
}

export const adsReview: ToolDefinition = {
  service: 'ads',
  command: 'review',
  description:
    '广告体检一条龙:活动清单(含启停状态/预算)+ 按活动绩效汇总(ACOS/花费零单标记)+ 白花钱搜索词;' +
    '可 --asin 聚焦某个商品。三张报表并行生成,替代串行跑 campaigns/performance/wasted-spend',
  mutation: 'none',
  isAsync: true,
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    { name: 'start', desc: '开始日期 YYYY-MM-DD(必填;数据只保留约 95 天,超 31 天自动分段)', required: true },
    { name: 'end', desc: '结束日期 YYYY-MM-DD(必填)', required: true },
    { name: 'asin', desc: '聚焦某个 ASIN:额外拉广告商品报表,标出该 ASIN 由哪些活动在投并过滤绩效/废词(可选)' },
    { name: 'min-clicks', desc: '废词判定:至少多少点击才算值得砍,默认 10(1-100000)' },
    { name: 'limit', desc: '废词最多返回多少个(可选,不给则跟随 --top;按花费降序)' },
    {
      name: 'top',
      desc:
        '绩效行与活动明细各最多返回多少条,默认 100' +
        '(绩效按最差排前;活动明细按 ENABLED > PAUSED > ARCHIVED 排序后取前 N)。' +
        'totals 与 total/enabled/paused/archived 计数始终按全量算,不受影响;' +
        '要拿全量明细用 ads performance --limit / ads campaigns --max',
    },
    { name: 'timeout', desc: '每张报表最长等待分钟数,默认 10(1-60)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    validateReportWindow(flags);
    requireOptionalAsin(flags);
    validateNumberFlag(flags, 'minClicks', '--min-clicks', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'top', '--top', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const start = requireDate(ctx.flags, 'start', '--start');
    const end = requireDate(ctx.flags, 'end', '--end');
    const asin = requireOptionalAsin(ctx.flags);
    const minClicks = Number(strFlag(ctx.flags, 'minClicks') ?? 10);
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);
    // 大账户(几千活动)全量返回 performance + campaigns.items 能到几 MB,
    // 直接撑爆 Agent 上下文。默认只给最差的 100 行——这条命令的用途是"喂给
    // Agent 判断怎么调",不是导出全量数据(那用 ads performance/campaigns)。
    const top = Number(strFlag(ctx.flags, 'top') ?? 100);
    const window = { start, end };

    ctx.progress(
      `· 广告体检:并行拉取活动清单 + ${asin ? '3' : '2'} 张报表(${start} ~ ${end})...`,
    );
    // 活动清单与所有报表同时发起:报表在亚马逊侧排队生成,清单顺带就拉完了
    const [campaignsRaw, perfRows, searchRows, productResult] = await Promise.all([
      listAllCampaigns(ctx, profileId),
      fetchAdsReportRows(
        ctx,
        profileId,
        {
          reportTypeId: 'spCampaigns',
          groupBy: ['campaign'],
          columns: ['date', 'campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'],
          ...window,
          desc: '广告活动层花费日报',
        },
        timeout,
      ),
      fetchAdsReportRows(
        ctx,
        profileId,
        {
          reportTypeId: 'spSearchTerm',
          groupBy: ['searchTerm'],
          columns: ['date', 'campaignId', 'adGroupId', 'searchTerm', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'],
          ...window,
          desc: '买家搜索词报表',
        },
        timeout,
      ),
      // --asin 的第三张报表是**可选增强**:它失败(报表类型不支持/超时/过期)不该把
      // 已经拿到手的活动清单、绩效、废词一起丢掉——那才是这条命令的主体价值。
      // 这里单独兜住异常,把失败信息放进 asinFocus,主体数据照常返回。
      asin
        ? fetchAdsReportRows(
            ctx,
            profileId,
            {
              reportTypeId: 'spAdvertisedProduct',
              groupBy: ['advertiser'],
              columns: ['date', 'campaignId', 'adGroupId', 'advertisedAsin', 'advertisedSku', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'],
              ...window,
              desc: '广告商品报表',
            },
            timeout,
          ).then(
            (rows): ProductReportResult => ({ rows }),
            (err: unknown): ProductReportResult => ({
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        : Promise.resolve<ProductReportResult>({ rows: [] }),
    ]);

    const stateOf = (c: Record<string, unknown>): string => String(c['state'] ?? '').toUpperCase();
    // 截断前先按状态排序:ENABLED > PAUSED > ARCHIVED > 其他,同级保持接口原序。
    // 否则 --top 砍掉的可能正好是在投的活动,而留下一堆归档的——那份清单没有意义,
    // 也与 --top 的说明("排序后取前 N")不符。
    const STATE_RANK: Record<string, number> = { ENABLED: 0, PAUSED: 1, ARCHIVED: 2 };
    const rankOf = (c: Record<string, unknown>): number => STATE_RANK[stateOf(c)] ?? 3;
    const sortedRaw = campaignsRaw
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rankOf(a.c) - rankOf(b.c) || a.i - b.i)
      .map((x) => x.c);
    const items = sortedRaw.map(trimCampaign);
    const allPerf = buildAdsPerfRows(perfRows, 'campaign');
    // performanceAll 是排序后的全量:计数、ASIN 聚焦过滤都基于它,
    // 只有最终输出的 performance 才截断——否则目标 ASIN 的活动若不在最差 100 名内,
    // asinFocus 会莫名其妙变成空的。
    const performanceAll = filterAndSortAdsPerfRows(allPerf, { by: 'campaign', minSpend: 0 });
    const performance = performanceAll.slice(0, top);
    const shownItems = items.slice(0, top);
    // 废词同样要有上限:--limit 明确给了就用它,没给就跟随 --top ——
    // 否则大账户上几千个废词照样把 payload 撑爆,--top 的目的只完成一半。
    const wastedAll = aggregateWastedSpend(searchRows, { minClicks });
    const wastedTerms = wastedAll.slice(0, limit ?? top);

    let asinFocus: Record<string, unknown> | undefined;
    if (asin && productResult.error !== undefined) {
      // 主体数据(campaigns/performance/wastedTerms)已经取到,照常返回;
      // 只把 ASIN 聚焦这一块标成失败,让调用方知道这部分为什么没有内容。
      asinFocus = {
        asin,
        error: 'ads.advertised_product_report_failed',
        note: '广告商品报表拉取失败,无法给出该 ASIN 的聚焦视图;campaigns/performance/wastedTerms 不受影响,可照常使用。',
        detail: productResult.error,
      };
    } else if (asin) {
      const byCampaign = aggregateAsinCampaigns(productResult.rows ?? [], asin);
      const ids = new Set(byCampaign.map((a) => a.campaignId).filter(Boolean));
      asinFocus = {
        asin,
        note: 'byCampaign=该 ASIN 在各活动下的表现;performance/wastedTerms 为只看这些活动的过滤视图',
        campaignCount: ids.size,
        byCampaign,
        // 用全量 performanceAll 过滤:该 ASIN 的活动可能排在 --top 截断线之外
        performance: performanceAll.filter((r) => r.campaignId !== undefined && ids.has(r.campaignId)),
        // 与 performance 同理:用全量废词过滤,否则目标活动的废词可能刚好被截断掉
        wastedTerms: wastedAll.filter(
          (t: WastedTerm) => t.campaignId !== undefined && ids.has(t.campaignId),
        ),
      };
    }

    return {
      profileId,
      window: `${start} ~ ${end}`,
      note:
        '数据已取齐:campaigns=活动清单(含启停/预算),performance=按活动绩效(spendNoSales=烧钱零销售,最差排前),' +
        'wastedTerms=白花钱搜索词(可直接喂 ads negative-batch)。调整判断请基于这些数据做。' +
        `performance/campaigns.items/wastedTerms 本次各最多给 ${limit ?? top} / ${top} 条(由 --top 与 --limit 控制),` +
        'totals 与 total/enabled/paused/archived 计数始终按全量算;' +
        '每组的 xxxCount 是过滤后的总数、xxxShown 是本次实际返回的条数(别拿 Count 去索引数组);' +
        '带 Truncated 标记时说明还有更多,要全量用 ads performance / ads campaigns。',
      campaigns: {
        total: items.length,
        enabled: campaignsRaw.filter((c) => stateOf(c) === 'ENABLED').length,
        paused: campaignsRaw.filter((c) => stateOf(c) === 'PAUSED').length,
        archived: campaignsRaw.filter((c) => stateOf(c) === 'ARCHIVED').length,
        itemsShown: shownItems.length,
        ...(items.length > shownItems.length ? { itemsTruncated: true } : {}),
        items: shownItems,
      },
      totals: buildReviewTotals(allPerf),
      // Count = 过滤后的总数,Shown = 本次实际返回的条数(与 campaigns 保持同一套命名,
      // 免得调用方拿 Count 去索引一个已经被截断的数组)
      performanceCount: performanceAll.length,
      performanceShown: performance.length,
      ...(performanceAll.length > performance.length ? { performanceTruncated: true } : {}),
      performance,
      wastedTermsCount: wastedAll.length,
      wastedTermsShown: wastedTerms.length,
      ...(wastedAll.length > wastedTerms.length ? { wastedTermsTruncated: true } : {}),
      wastedTerms,
      ...(asinFocus ? { asinFocus } : {}),
    };
  },
};
