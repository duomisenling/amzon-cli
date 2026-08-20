// sales product-performance —— 全店按子 ASIN 对比相邻两个周期的销售与流量
//
// 用途:给 Agent 一个可靠的全店候选入口,回答“哪些商品最近卖差了”,再交给广告/Listing
// 诊断。命令只做 Amazon 本店事实的取数、对比、标记和排序,不把候选直接等同于广告问题。
//
// 数据源:Reports API GET_SALES_AND_TRAFFIC_REPORT,asinGranularity=CHILD。
// 官方建议单次日期范围 7-30 天;本命令请求当前期和紧邻的前一期两份报告。

import { createHash } from 'node:crypto';
import { AmzError } from '../../internal/errs/errors.js';
import type { Region } from '../../internal/client/regions.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import {
  downloadReportDocument,
  requestReport,
  requireReportDocumentId,
  waitForReport,
} from '../report/infra.js';

export interface ProductPeriodMetrics {
  asin: string;
  parentAsin?: string;
  units: number;
  orders: number;
  sales: number;
  currency?: string;
  sessions: number;
  unitSessionPercentage: number | null;
  buyBoxPercentage: number | null;
}

export type ProductPerformanceReason =
  | 'sales-decline'
  | 'traffic-no-conversion'
  | 'conversion-decline'
  | 'buybox-decline';

export interface ProductPerformanceCandidate {
  asin: string;
  parentAsin?: string;
  current: ProductPeriodMetrics;
  previous: ProductPeriodMetrics;
  change: {
    units: number;
    unitsPercentage: number | null;
    salesPercentage: number | null;
    sessionsPercentage: number | null;
    unitSessionPercentagePoints: number | null;
    buyBoxPercentagePoints: number | null;
  };
  reasons: ProductPerformanceReason[];
  /** 只用于候选排序,不是业务健康分或广告调整依据。 */
  candidateScore: number;
}

export interface ProductPerformanceOptions {
  minPriorUnits: number;
  declinePercentage: number;
  minSessions: number;
  buyBoxDropPoints: number;
  limit: number;
  offset?: number;
}

export interface ParsedSalesTrafficReport {
  rows: ProductPeriodMetrics[];
  excludedParents: string[];
}

interface Acc {
  asin: string;
  parentAsin?: string;
  units: number;
  orders: number;
  sales: number;
  currency?: string;
  sessions: number;
  buyBoxWeighted: number;
  buyBoxWeight: number;
}

function n(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pctChange(current: number, previous: number): number | null {
  return previous > 0 ? round(((current - previous) / previous) * 100, 1) : null;
}

function emptyMetrics(asin: string): ProductPeriodMetrics {
  return {
    asin,
    units: 0,
    orders: 0,
    sales: 0,
    sessions: 0,
    unitSessionPercentage: null,
    buyBoxPercentage: null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Resolve the latest complete UTC day. Explicit dates make later batches reproducible. */
export function resolveProductPerformanceAsOf(
  value: string | undefined,
  now = Date.now(),
): string {
  const latest = utcDateOnly(now - DAY_MS);
  if (!value) return latest;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'sales.invalid_as_of',
      param: '--as-of',
      hintAgent: 'fix_param',
      hintHuman: '--as-of 必须是 YYYY-MM-DD，并且不能晚于昨天（UTC）。',
      message: `invalid --as-of date: ${value}`,
    });
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || utcDateOnly(timestamp) !== value || value > latest) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'sales.invalid_as_of',
      param: '--as-of',
      hintAgent: 'fix_param',
      hintHuman: `--as-of 必须是真实日期，且不能晚于 ${latest}（昨天，UTC）。`,
      message: `--as-of ${value} is invalid or later than ${latest}`,
    });
  }
  return value;
}

export function buildProductPerformanceWindows(
  days: number,
  asOfOrNow: string | number = Date.now(),
): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const asOf =
    typeof asOfOrNow === 'string'
      ? resolveProductPerformanceAsOf(asOfOrNow, Date.parse(`${asOfOrNow}T00:00:00Z`) + DAY_MS)
      : resolveProductPerformanceAsOf(undefined, asOfOrNow);
  const currentEndExclusive = Date.parse(`${asOf}T00:00:00Z`) + DAY_MS;
  const currentStartTimestamp = currentEndExclusive - days * DAY_MS;
  const previousStartTimestamp = currentStartTimestamp - days * DAY_MS;
  const startIso = (timestamp: number): string => new Date(timestamp).toISOString().replace('.000Z', 'Z');
  const endIso = (exclusiveTimestamp: number): string =>
    new Date(exclusiveTimestamp - 1_000).toISOString().replace('.000Z', 'Z');
  return {
    currentStart: startIso(currentStartTimestamp),
    currentEnd: endIso(currentEndExclusive),
    previousStart: startIso(previousStartTimestamp),
    previousEnd: endIso(currentStartTimestamp),
  };
}

/**
 * 解析 Sales & Traffic JSON,并对同一子 ASIN 的多行求和。
 * 百分比不直接平均:unit-session 用总销量/总 sessions 重算;Buy Box 按 sessions 加权。
 */
export function parseSalesTrafficReport(reportJsonText: string): ParsedSalesTrafficReport {
  let data: unknown;
  try {
    data = JSON.parse(reportJsonText);
  } catch {
    return { rows: [], excludedParents: [] };
  }
  const rows = (data as { salesAndTrafficByAsin?: unknown })?.salesAndTrafficByAsin;
  if (!Array.isArray(rows)) return { rows: [], excludedParents: [] };

  const map = new Map<string, Acc>();
  const parentAsins = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const asinValue = row['childAsin'] ?? row['asin'] ?? row['parentAsin'];
    const asin = typeof asinValue === 'string' ? asinValue.trim().toUpperCase() : '';
    if (!asin) continue;
    const childAsin = typeof row['childAsin'] === 'string' ? row['childAsin'].trim().toUpperCase() : '';
    const parentAsinValue =
      typeof row['parentAsin'] === 'string' ? row['parentAsin'].trim().toUpperCase() : '';
    if (childAsin && parentAsinValue && childAsin !== parentAsinValue) {
      parentAsins.add(parentAsinValue);
    }

    const salesByAsin = (row['salesByAsin'] ?? {}) as Record<string, unknown>;
    const trafficByAsin = (row['trafficByAsin'] ?? {}) as Record<string, unknown>;
    const orderedProductSales = (salesByAsin['orderedProductSales'] ?? {}) as Record<
      string,
      unknown
    >;
    const sessionsRaw = optionalNumber(trafficByAsin['sessions']);
    const sessions =
      sessionsRaw ??
      n(trafficByAsin['browserSessions']) + n(trafficByAsin['mobileAppSessions']);
    const buyBox = optionalNumber(trafficByAsin['buyBoxPercentage']);

    let acc = map.get(asin);
    if (!acc) {
      acc = {
        asin,
        units: 0,
        orders: 0,
        sales: 0,
        sessions: 0,
        buyBoxWeighted: 0,
        buyBoxWeight: 0,
      };
      map.set(asin, acc);
    }
    const parentAsin = row['parentAsin'];
    if (!acc.parentAsin && typeof parentAsin === 'string' && parentAsin.trim()) {
      acc.parentAsin = parentAsin.trim().toUpperCase();
    }
    acc.units += n(salesByAsin['unitsOrdered']);
    acc.orders += n(salesByAsin['totalOrderItems']);
    acc.sales += n(orderedProductSales['amount']);
    acc.currency ||=
      typeof orderedProductSales['currencyCode'] === 'string'
        ? orderedProductSales['currencyCode']
        : undefined;
    acc.sessions += sessions;
    if (buyBox !== undefined) {
      const weight = sessions > 0 ? sessions : 1;
      acc.buyBoxWeighted += buyBox * weight;
      acc.buyBoxWeight += weight;
    }
  }

  const parsed = [...map.values()].map((acc) => ({
    asin: acc.asin,
    ...(acc.parentAsin ? { parentAsin: acc.parentAsin } : {}),
    units: acc.units,
    orders: acc.orders,
    sales: round(acc.sales, 2),
    ...(acc.currency ? { currency: acc.currency } : {}),
    sessions: acc.sessions,
    unitSessionPercentage:
      acc.sessions > 0 ? round((acc.units / acc.sessions) * 100, 2) : null,
    buyBoxPercentage:
      acc.buyBoxWeight > 0 ? round(acc.buyBoxWeighted / acc.buyBoxWeight, 2) : null,
  }));
  return {
    rows: parsed.filter((row) => !parentAsins.has(row.asin)),
    excludedParents: [...parentAsins].filter((asin) => map.has(asin)).sort(),
  };
}

export function parseSalesTrafficByAsin(reportJsonText: string): ProductPeriodMetrics[] {
  return parseSalesTrafficReport(reportJsonText).rows;
}

/** 纯函数:两个相邻周期 → 可解释的候选原因与排序。候选不等同于广告问题。 */
export function rankProductPerformanceCandidates(
  currentRows: ProductPeriodMetrics[],
  previousRows: ProductPeriodMetrics[],
  opts: ProductPerformanceOptions,
): ProductPerformanceCandidate[] {
  const current = new Map(currentRows.map((row) => [row.asin, row]));
  const previous = new Map(previousRows.map((row) => [row.asin, row]));
  const asins = new Set([...current.keys(), ...previous.keys()]);
  const out: ProductPerformanceCandidate[] = [];

  for (const asin of asins) {
    const now = current.get(asin) ?? emptyMetrics(asin);
    const before = previous.get(asin) ?? emptyMetrics(asin);
    const unitsPercentage = pctChange(now.units, before.units);
    const salesPercentage = pctChange(now.sales, before.sales);
    const sessionsPercentage = pctChange(now.sessions, before.sessions);
    const unitSessionPercentagePoints =
      now.unitSessionPercentage !== null && before.unitSessionPercentage !== null
        ? round(now.unitSessionPercentage - before.unitSessionPercentage, 2)
        : null;
    const buyBoxPercentagePoints =
      now.buyBoxPercentage !== null && before.buyBoxPercentage !== null
        ? round(now.buyBoxPercentage - before.buyBoxPercentage, 2)
        : null;

    const reasons: ProductPerformanceReason[] = [];
    let score = 0;
    const unitDrop = unitsPercentage === null ? 0 : Math.max(0, -unitsPercentage);
    if (before.units >= opts.minPriorUnits && unitDrop >= opts.declinePercentage) {
      reasons.push('sales-decline');
      score += unitDrop;
    }
    if (now.sessions >= opts.minSessions && now.units === 0) {
      reasons.push('traffic-no-conversion');
      score += 100 + Math.min(50, now.sessions / 10);
    }
    const previousConversion = before.unitSessionPercentage ?? 0;
    const conversionDropRelative =
      previousConversion > 0 && now.unitSessionPercentage !== null
        ? ((previousConversion - now.unitSessionPercentage) / previousConversion) * 100
        : 0;
    if (
      now.sessions >= opts.minSessions &&
      before.sessions >= opts.minSessions &&
      conversionDropRelative >= opts.declinePercentage
    ) {
      reasons.push('conversion-decline');
      score += conversionDropRelative;
    }
    if (
      buyBoxPercentagePoints !== null &&
      now.sessions >= opts.minSessions &&
      buyBoxPercentagePoints <= -opts.buyBoxDropPoints
    ) {
      reasons.push('buybox-decline');
      score += Math.abs(buyBoxPercentagePoints);
    }
    if (reasons.length === 0) continue;

    out.push({
      asin,
      ...(now.parentAsin || before.parentAsin
        ? { parentAsin: now.parentAsin ?? before.parentAsin }
        : {}),
      current: now,
      previous: before,
      change: {
        units: now.units - before.units,
        unitsPercentage,
        salesPercentage,
        sessionsPercentage,
        unitSessionPercentagePoints,
        buyBoxPercentagePoints,
      },
      reasons,
      candidateScore: round(score, 1),
    });
  }

  return out.sort(
    (a, b) => b.candidateScore - a.candidateScore || a.asin.localeCompare(b.asin),
  );
}

export function selectProductPerformanceCandidates(
  currentRows: ProductPeriodMetrics[],
  previousRows: ProductPeriodMetrics[],
  opts: ProductPerformanceOptions,
): ProductPerformanceCandidate[] {
  const offset = opts.offset ?? 0;
  return rankProductPerformanceCandidates(currentRows, previousRows, opts).slice(
    offset,
    offset + opts.limit,
  );
}

type ReportDownloader = typeof downloadReportDocument;
type Delay = (milliseconds: number) => Promise<void>;

/** Retry only the document download: the already-generated report is never requested again. */
export async function downloadReportWithRetry(
  ctx: ToolContext,
  reportId: string,
  reportDocumentId: string,
  region: Region | undefined,
  downloader: ReportDownloader = downloadReportDocument,
  delay: Delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloader(ctx, reportDocumentId, region);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        ctx.progress(`· 报告下载失败，保留 reportId=${reportId}，第 ${attempt + 1}/3 次续传...`);
        await delay(attempt * 1_000);
      }
    }
  }
  throw new AmzError({
    type: 'upstream_error',
    subtype: 'report.download_resume_required',
    hintAgent: 'backoff_and_retry',
    hintHuman:
      `报告 ${reportId} 已生成，但内容连续 3 次下载失败。` +
      `可稍后用 report download --report-id ${reportId} 继续下载，不需要重新生成报告。`,
    message: `failed to download generated report ${reportId} after 3 attempts`,
    retryable: true,
    cause: lastError,
  });
}

async function fetchPeriod(
  ctx: ToolContext,
  marketplace: ReturnType<typeof resolveMarketplace>,
  start: string,
  end: string,
  timeout: number,
): Promise<{
  rows: ProductPeriodMetrics[];
  excludedParents: string[];
  empty: boolean;
  reportId?: string;
}> {
  let reportId: string | undefined;
  try {
    reportId = await requestReport(ctx, 'GET_SALES_AND_TRAFFIC_REPORT', marketplace, {
      dataStartTime: start,
      dataEndTime: end,
      reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' },
    });
    const status = await waitForReport(ctx, reportId, timeout, marketplace.region);
    const text = await downloadReportWithRetry(
      ctx,
      reportId,
      requireReportDocumentId(status),
      marketplace.region,
    );
    const parsed = parseSalesTrafficReport(text);
    return { ...parsed, empty: false, reportId };
  } catch (error) {
    if (error instanceof AmzError && error.subtype === 'report.cancelled') {
      return { rows: [], excludedParents: [], empty: true, ...(reportId ? { reportId } : {}) };
    }
    throw error;
  }
}

export const salesProductPerformance: ToolDefinition = {
  service: 'sales',
  command: 'product-performance',
  description:
    '全店按子ASIN对比最近N天与前N天的销量/销售额/Sessions/转化/Buy Box,筛出下降或有流量不转化的候选;只读,候选不等同于广告问题',
  mutation: 'none',
  isAsync: true,
  roles: ['Selling Partner Insights'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / JP / DE(必填)', required: true },
    { name: 'days', desc: '每个对比周期的天数,默认30(7-30)' },
    { name: 'as-of', desc: '当前周期最后一个完整UTC日期,YYYY-MM-DD;默认昨天。固定后可稳定续取下一批' },
    { name: 'min-prior-units', desc: '前期至少多少件才判断销量下降,默认3' },
    { name: 'decline-percent', desc: '销量或转化相对下降多少算候选,默认30(百分比)' },
    { name: 'min-sessions', desc: '判断有流量不转化/转化下降的最少Sessions,默认20' },
    { name: 'buybox-drop-points', desc: 'Buy Box下降多少个百分点算候选,默认20' },
    { name: 'limit', desc: '最多返回候选数,默认20(1-100)' },
    { name: 'offset', desc: '从排序后的第几个候选开始返回,默认0;与同一 --as-of 配合取下一批' },
    { name: 'timeout', desc: '每份报告最长等待分钟数,默认10(1-60)' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'days', '--days', { min: 7, max: 30, integer: true });
    validateNumberFlag(flags, 'minPriorUnits', '--min-prior-units', {
      min: 1,
      max: 1_000_000,
      integer: true,
    });
    validateNumberFlag(flags, 'declinePercent', '--decline-percent', { min: 1, max: 100 });
    validateNumberFlag(flags, 'minSessions', '--min-sessions', {
      min: 1,
      max: 100_000_000,
      integer: true,
    });
    validateNumberFlag(flags, 'buyboxDropPoints', '--buybox-drop-points', {
      min: 1,
      max: 100,
    });
    validateNumberFlag(flags, 'limit', '--limit', { min: 1, max: 100, integer: true });
    validateNumberFlag(flags, 'offset', '--offset', { min: 0, max: 100_000, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
    resolveProductPerformanceAsOf(strFlag(flags, 'asOf'));
  },
  execute: async (ctx) => {
    const marketplace = resolveMarketplace(ctx.flags['marketplace']);
    const days = Number(strFlag(ctx.flags, 'days') ?? 30);
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);
    const asOf = resolveProductPerformanceAsOf(strFlag(ctx.flags, 'asOf'));
    const offset = Number(strFlag(ctx.flags, 'offset') ?? 0);
    const options: ProductPerformanceOptions = {
      minPriorUnits: Number(strFlag(ctx.flags, 'minPriorUnits') ?? 3),
      declinePercentage: Number(strFlag(ctx.flags, 'declinePercent') ?? 30),
      minSessions: Number(strFlag(ctx.flags, 'minSessions') ?? 20),
      buyBoxDropPoints: Number(strFlag(ctx.flags, 'buyboxDropPoints') ?? 20),
      limit: Number(strFlag(ctx.flags, 'limit') ?? 20),
      offset,
    };
    // 排除最近24小时,降低报告尚未完整回补导致的误判;两个窗口保持等长且相邻。
    const { currentStart, currentEnd, previousStart, previousEnd } =
      buildProductPerformanceWindows(days, asOf);

    const previous = await fetchPeriod(
      ctx,
      marketplace,
      previousStart,
      previousEnd,
      timeout,
    );
    const current = await fetchPeriod(ctx, marketplace, currentStart, currentEnd, timeout);
    const excludedParents = new Set([...current.excludedParents, ...previous.excludedParents]);
    const currentRows = current.rows.filter((row) => !excludedParents.has(row.asin));
    const previousRows = previous.rows.filter((row) => !excludedParents.has(row.asin));
    const ranked = rankProductPerformanceCandidates(currentRows, previousRows, options);
    const candidates = ranked.slice(offset, offset + options.limit);
    const nextOffset = offset + candidates.length;
    const hasMore = nextOffset < ranked.length;
    const scanId = `adsscan_${createHash('sha256')
      .update(
        JSON.stringify({
          marketplace: marketplace.country,
          asOf,
          days,
          thresholds: {
            minPriorUnits: options.minPriorUnits,
            declinePercentage: options.declinePercentage,
            minSessions: options.minSessions,
            buyBoxDropPoints: options.buyBoxDropPoints,
          },
        }),
      )
      .digest('hex')
      .slice(0, 16)}`;

    return {
      marketplace: marketplace.country,
      dataSource: 'Amazon GET_SALES_AND_TRAFFIC_REPORT',
      granularity: 'CHILD_ASIN',
      scanId,
      asOf,
      currentWindow: { start: currentStart, end: currentEnd, empty: current.empty },
      previousWindow: { start: previousStart, end: previousEnd, empty: previous.empty },
      thresholds: {
        minPriorUnits: options.minPriorUnits,
        declinePercentage: options.declinePercentage,
        minSessions: options.minSessions,
        buyBoxDropPoints: options.buyBoxDropPoints,
      },
      reportIds: { previous: previous.reportId, current: current.reportId },
      excludedParents: [...excludedParents].sort(),
      scannedAsins: new Set([...currentRows.map((row) => row.asin), ...previousRows.map((row) => row.asin)]).size,
      offset,
      limit: options.limit,
      totalCandidates: ranked.length,
      count: candidates.length,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      interpretation:
        'rows只是需要进一步诊断的候选,不等同于广告问题或应执行动作;必须继续检查库存、可售性、Buy Box、Listing和广告映射。',
      rows: candidates,
    };
  },
};
