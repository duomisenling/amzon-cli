// ads performance —— 广告绩效总览:按 campaign(或广告组)汇总花费/销量/ACOS,最差排前
//
// 背景:运营每天盯广告,要判断"哪些 campaign 在烧钱 / ACOS 超标 / 有花费零单"。
//   现状是拉 spCampaigns 原始日报再自己按活动汇总、算 ACOS——最容易调用爆炸。
//   这里收成一条命令:拉 spCampaigns 报表 → 按活动(或活动×广告组)汇总天级明细 →
//   算 ACOS/CTR/CVR/CPC → 把"有花费零转化"标出来、按最差排序。
//   结果带 campaignId/adGroupId,便于直接接批量改竞价/预算。
//
// 口径:CLI 只做取数+汇总+排序+标记,阈值筛选用可选 flag;是否要动由下游/人判定。
// 数据源:Amazon Ads V3 报表 spCampaigns(复用 ads/report 的 fetchAdsReportRows)

import type { ToolDefinition } from '../../tools/types.js';
import { strFlag, validateNumberFlag } from '../common.js';
import { ADS_REGION_FLAG, requireDate, requireProfileId, validateReportWindow } from './common.js';
import { fetchAdsReportRows } from './report.js';

export interface AdsPerfRow {
  campaignId?: string;
  campaignName?: string;
  /** 仅 --by ad-group 时有 */
  adGroupId?: string;
  adGroupName?: string;
  impressions: number;
  clicks: number;
  /** 花费(货币,两位小数) */
  cost: number;
  /** 归因订单数(purchases7d) */
  orders: number;
  /** 归因销售额(sales7d,货币,两位小数) */
  sales: number;
  /** ACOS 百分比(cost/sales*100,一位小数);无销售额时为 null */
  acos: number | null;
  /** 点击率百分比(clicks/impressions*100,两位小数);无曝光为 null */
  ctr: number | null;
  /** 转化率百分比(orders/clicks*100,两位小数);无点击为 null */
  cvr: number | null;
  /** 单次点击成本(cost/clicks,两位小数);无点击为 null */
  cpc: number | null;
  /** 有花费但零销售额 —— 纯烧钱,优先处理 */
  spendNoSales: boolean;
}

export interface AdsPerfOptions {
  by: 'campaign' | 'ad-group';
  /** 只看花费 ≥ 该值的(过滤噪声),默认 0 */
  minSpend: number;
  /** 只留 ACOS ≥ 该百分比的(超标筛选);spendNoSales 始终保留 */
  acosMin?: number;
  limit?: number;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function round(v: number, d: number): number {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function firstStr(prev: string | undefined, v: unknown): string | undefined {
  if (prev) return prev;
  const s = v != null ? String(v).trim() : '';
  return s.length > 0 ? s : undefined;
}

interface Acc {
  campaignId?: string;
  campaignName?: string;
  adGroupId?: string;
  adGroupName?: string;
  impressions: number;
  clicks: number;
  cost: number;
  orders: number;
  sales: number;
}

/**
 * 纯聚合:天级明细 → 按活动(或活动×广告组)汇总 → 算派生指标 → 标"花费零单"。
 * 返回未过滤、未排序的全量列表;总体指标必须在这份全量上算,避免被筛选口径误导。
 */
export function buildAdsPerfRows(
  rows: Array<Record<string, unknown>>,
  by: 'campaign' | 'ad-group',
): AdsPerfRow[] {
  const byAdGroup = by === 'ad-group';
  const map = new Map<string, Acc>();
  for (const row of rows) {
    const campaignId = row['campaignId'] != null ? String(row['campaignId']) : undefined;
    const adGroupId = row['adGroupId'] != null ? String(row['adGroupId']) : undefined;
    const key = byAdGroup ? `${campaignId ?? ''} ${adGroupId ?? ''}` : (campaignId ?? '');
    let agg = map.get(key);
    if (!agg) {
      agg = {
        campaignId,
        adGroupId: byAdGroup ? adGroupId : undefined,
        impressions: 0,
        clicks: 0,
        cost: 0,
        orders: 0,
        sales: 0,
      };
      map.set(key, agg);
    }
    agg.campaignName = firstStr(agg.campaignName, row['campaignName']);
    if (byAdGroup) agg.adGroupName = firstStr(agg.adGroupName, row['adGroupName']);
    agg.impressions += n(row['impressions']);
    agg.clicks += n(row['clicks']);
    agg.cost += n(row['cost']);
    agg.orders += n(row['purchases7d'] ?? row['purchases']);
    agg.sales += n(row['sales7d'] ?? row['sales']);
  }

  const out: AdsPerfRow[] = [];
  for (const a of map.values()) {
    const spendNoSales = a.cost > 0 && a.sales <= 0;
    const acos = a.sales > 0 ? round((a.cost / a.sales) * 100, 1) : null;
    const ctr = a.impressions > 0 ? round((a.clicks / a.impressions) * 100, 2) : null;
    const cvr = a.clicks > 0 ? round((a.orders / a.clicks) * 100, 2) : null;
    const cpc = a.clicks > 0 ? round(a.cost / a.clicks, 2) : null;
    out.push({
      campaignId: a.campaignId,
      campaignName: a.campaignName,
      ...(byAdGroup ? { adGroupId: a.adGroupId, adGroupName: a.adGroupName } : {}),
      impressions: a.impressions,
      clicks: a.clicks,
      cost: round(a.cost, 2),
      orders: a.orders,
      sales: round(a.sales, 2),
      acos,
      ctr,
      cvr,
      cpc,
      spendNoSales,
    });
  }
  return out;
}

/** 纯函数:在全量汇总行上应用阈值筛选 + 最差排前 + limit 截断。 */
export function filterAndSortAdsPerfRows(all: AdsPerfRow[], opts: AdsPerfOptions): AdsPerfRow[] {
  // 排序权重:纯烧钱视作 ACOS 无穷大,排最前
  const weight = (r: AdsPerfRow): number =>
    r.spendNoSales ? Number.POSITIVE_INFINITY : (r.acos ?? -1);
  const filtered = all
    .filter((r) => r.cost >= opts.minSpend)
    .filter((r) =>
      opts.acosMin === undefined ? true : r.spendNoSales || (r.acos ?? -1) >= opts.acosMin,
    )
    .sort((a, b) => {
      const wa = weight(a);
      const wb = weight(b);
      if (wa !== wb) return wb - wa;
      return b.cost - a.cost;
    });
  return typeof opts.limit === 'number' ? filtered.slice(0, opts.limit) : filtered;
}

/**
 * 纯聚合(汇总+筛选一步到位):天级明细 → 按活动(或活动×广告组)汇总 → 筛选排序。
 * 排序:先纯烧钱(有花费零销售额,花费降序),再按 ACOS 降序,平手按花费降序。
 */
export function aggregateAdsPerformance(
  rows: Array<Record<string, unknown>>,
  opts: AdsPerfOptions,
): AdsPerfRow[] {
  return filterAndSortAdsPerfRows(buildAdsPerfRows(rows, opts.by), opts);
}

export const adsPerformance: ToolDefinition = {
  service: 'ads',
  command: 'performance',
  description:
    '广告绩效总览:按 campaign(或广告组)汇总花费/销量/ACOS,标出"有花费零单",最差排前;带 campaignId 便于接批量改竞价/预算',
  mutation: 'none',
  isAsync: true,
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    { name: 'start', desc: '开始日期 YYYY-MM-DD(必填)', required: true },
    { name: 'end', desc: '结束日期 YYYY-MM-DD(必填)', required: true },
    { name: 'by', desc: '汇总粒度:campaign(默认)| ad-group' },
    { name: 'min-spend', desc: '只看花费≥该值的,过滤噪声(默认 0)' },
    { name: 'acos-min', desc: '只留 ACOS≥该百分比的(如 50 = 50%);有花费零单的始终保留' },
    { name: 'limit', desc: '最多返回多少行(可选,默认全部,最差排前)' },
    { name: 'timeout', desc: '报表最长等待分钟数,默认 10(1-60;跨度>31 天自动分段拉取,按段计时)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    validateReportWindow(flags);
    const by = strFlag(flags, 'by');
    if (by !== undefined && by !== 'campaign' && by !== 'ad-group') {
      throw new Error('--by 只能是 campaign 或 ad-group');
    }
    validateNumberFlag(flags, 'minSpend', '--min-spend', { min: 0, max: 1_000_000_000 });
    validateNumberFlag(flags, 'acosMin', '--acos-min', { min: 0, max: 1_000_000 });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const start = requireDate(ctx.flags, 'start', '--start');
    const end = requireDate(ctx.flags, 'end', '--end');
    const by = (strFlag(ctx.flags, 'by') as 'campaign' | 'ad-group' | undefined) ?? 'campaign';
    const minSpend = Number(strFlag(ctx.flags, 'minSpend') ?? 0);
    const acosMinRaw = strFlag(ctx.flags, 'acosMin');
    const acosMin = acosMinRaw !== undefined ? Number(acosMinRaw) : undefined;
    const limitRaw = strFlag(ctx.flags, 'limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);

    const byAdGroup = by === 'ad-group';
    const rows = await fetchAdsReportRows(
      ctx,
      profileId,
      {
        reportTypeId: 'spCampaigns',
        groupBy: byAdGroup ? ['campaign', 'adGroup'] : ['campaign'],
        columns: [
          'date',
          'campaignId',
          'campaignName',
          ...(byAdGroup ? ['adGroupId', 'adGroupName'] : []),
          'impressions',
          'clicks',
          'cost',
          'purchases7d',
          'sales7d',
        ],
        start,
        end,
        desc: '广告活动层花费日报',
      },
      timeout,
    );

    // 总体指标在过滤前的全量上算;rows 才应用 --min-spend/--acos-min/--limit 筛选,
    // 避免"筛剩几行的合计"被误读成账户总体花费/ACOS。
    const all = buildAdsPerfRows(rows, by);
    const list = filterAndSortAdsPerfRows(all, { by, minSpend, acosMin, limit });
    const totalSpend = round(
      all.reduce((s, r) => s + r.cost, 0),
      2,
    );
    const totalSales = round(
      all.reduce((s, r) => s + r.sales, 0),
      2,
    );
    const overallAcos = totalSales > 0 ? round((totalSpend / totalSales) * 100, 1) : null;

    return {
      profileId,
      window: `${start} ~ ${end}`,
      by,
      totals_note: 'totalSpend/totalSales/overallAcos/spendNoSalesCount 按过滤前全量计算;rows 为筛选后结果(filteredCount/totalCount)',
      filteredCount: list.length,
      totalCount: all.length,
      count: list.length,
      spendNoSalesCount: all.filter((r) => r.spendNoSales).length,
      totalSpend,
      totalSales,
      overallAcos,
      rows: list,
    };
  },
};
