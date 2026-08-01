// listing issues —— 一步揪出"有问题/被压制/搜不到"的在售 listing
//
// 背景:运营最怕 listing 悄悄被压制、搜不到还卖着断流量。现状要反复 listing mine 翻页再自己筛。
//   这里收成一条命令:自动翻页拉全本店 listing(summaries+issues)→ 只留有问题的 →
//   压缩成精简行 {sku, asin, itemName, status, issues[]},并汇总 suppressed/搜不到/error 数。
//   默认用服务端 withIssueSeverity=ERROR 过滤,只取带 ERROR 问题的 listing(最省调用);
//   --severity 可放宽,--full-scan 改为全量扫描(能额外抓到"状态被压制但暂无 issue"的)。
//
// API: Listings Items 2021-08-01 searchListingsItems(见 listing/mine.ts 已核实用法)
//   GET /listings/2021-08-01/items/{sellerId}?includedData=summaries,issues&withIssueSeverity=…
//   翻页:pagination.nextToken;pageSize 最大 20。

import { writeFileSync } from 'node:fs';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import { resolveSellerId } from './mine.js';

export interface ListingIssue {
  code?: string;
  severity?: string;
  message?: string;
  attributeNames?: string[];
}

export interface ListingIssueRow {
  sku: string;
  asin?: string;
  itemName?: string;
  /** summaries[].status 数组,如 ["BUYABLE","DISCOVERABLE"] */
  status?: string[];
  /** 能否购买(status 含 BUYABLE);无 status 时 null */
  buyable: boolean | null;
  /** 能否被搜到(status 含 DISCOVERABLE);无 status 时 null */
  discoverable: boolean | null;
  issueCount: number;
  issues: ListingIssue[];
}

export interface ListingIssuesSummary {
  rows: ListingIssueRow[];
  counts: {
    problems: number;
    withErrors: number;
    withWarnings: number;
    suppressed: number; // 不可购买
    searchHidden: number; // 搜不到
  };
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

function compactIssue(raw: Record<string, unknown>): ListingIssue {
  const attributeNames = Array.isArray(raw['attributeNames'])
    ? (raw['attributeNames'] as unknown[]).map((a) => String(a))
    : undefined;
  return {
    ...(raw['code'] != null ? { code: String(raw['code']) } : {}),
    ...(raw['severity'] != null ? { severity: String(raw['severity']) } : {}),
    ...(raw['message'] != null ? { message: String(raw['message']) } : {}),
    ...(attributeNames && attributeNames.length > 0 ? { attributeNames } : {}),
  };
}

const SEVERITY_RANK: Record<string, number> = { INFO: 1, WARNING: 2, ERROR: 3 };

/**
 * 纯函数:把 searchListingsItems 的 items 压成"有问题的" listing 行 + 汇总计数。
 * 有问题 = 有 issue(达到 minSeverity)或 状态缺 BUYABLE/DISCOVERABLE(被压制/搜不到)。
 * minSeverity 只影响"计入问题的 issue 门槛";状态被压制始终计为问题。
 */
export function summarizeListingIssues(
  items: Array<Record<string, unknown>>,
  minSeverity: 'INFO' | 'WARNING' | 'ERROR' = 'ERROR',
): ListingIssuesSummary {
  const minRank = SEVERITY_RANK[minSeverity] ?? 3;
  const rows: ListingIssueRow[] = [];
  let withErrors = 0;
  let withWarnings = 0;
  let suppressed = 0;
  let searchHidden = 0;

  for (const item of items) {
    const sku = typeof item['sku'] === 'string' ? item['sku'] : '';
    const summaries = asArray(item['summaries']);
    const summary = summaries[0] ?? {};
    const asin = summary['asin'] != null ? String(summary['asin']) : undefined;
    const itemName = summary['itemName'] != null ? String(summary['itemName']) : undefined;
    const statusRaw = Array.isArray(summary['status'])
      ? (summary['status'] as unknown[]).map((s) => String(s))
      : undefined;
    const buyable = statusRaw ? statusRaw.includes('BUYABLE') : null;
    const discoverable = statusRaw ? statusRaw.includes('DISCOVERABLE') : null;

    const allIssues = asArray(item['issues']).map(compactIssue);
    const countedIssues = allIssues.filter(
      (i) => (SEVERITY_RANK[String(i.severity ?? '').toUpperCase()] ?? 0) >= minRank,
    );

    const statusProblem = buyable === false || discoverable === false;
    if (countedIssues.length === 0 && !statusProblem) continue; // 无问题,跳过

    if (buyable === false) suppressed++;
    if (discoverable === false) searchHidden++;
    if (allIssues.some((i) => String(i.severity ?? '').toUpperCase() === 'ERROR')) withErrors++;
    if (allIssues.some((i) => String(i.severity ?? '').toUpperCase() === 'WARNING')) withWarnings++;

    rows.push({
      sku,
      asin,
      itemName,
      ...(statusRaw ? { status: statusRaw } : {}),
      buyable,
      discoverable,
      issueCount: countedIssues.length,
      issues: countedIssues,
    });
  }

  return {
    rows,
    counts: { problems: rows.length, withErrors, withWarnings, suppressed, searchHidden },
  };
}

/** minSeverity → 服务端 withIssueSeverity(仅 ERROR/WARNING 有此过滤;INFO 走全量)。 */
function serverSeverityFilter(minSeverity: string, fullScan: boolean): string | undefined {
  if (fullScan) return undefined;
  if (minSeverity === 'ERROR' || minSeverity === 'WARNING') return minSeverity;
  return undefined;
}

export const listingIssues: ToolDefinition = {
  service: 'listing',
  command: 'issues',
  description:
    '一步揪出有问题/被压制/搜不到的在售 listing:自动翻页拉全本店 listing,只留有问题的,' +
    '压缩成 {sku,asin,itemName,status,issues} 并汇总 suppressed/搜不到/error 数。大结果集用 --out',
  mutation: 'none',
  isAsync: true,
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'seller-id', desc: '卖家编号(本地模式可省并读 SELLER_ID)' },
    {
      name: 'severity',
      desc: '计入问题的最低严重度,默认 ERROR;WARNING 含 WARNING+ERROR;INFO 含全部(走全量扫描)',
      enum: ['ERROR', 'WARNING', 'INFO'],
    },
    { name: 'full-scan', desc: '全量扫描所有 listing(能额外抓到状态被压制但暂无 issue 的);不加则服务端只取带该严重度问题的', type: 'boolean' },
    { name: 'max-pages', desc: '最多翻多少页(每页 20),默认 500(=1万 SKU);到顶会在结果里提示' },
    { name: 'out', desc: '把完整结果写到该 JSON 文件(大店铺建议用),stdout 只回汇总' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'maxPages', '--max-pages', { min: 1, max: 100_000, integer: true });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const minSeverity = (strFlag(ctx.flags, 'severity') as 'ERROR' | 'WARNING' | 'INFO' | undefined) ?? 'ERROR';
    const fullScan = ctx.flags['fullScan'] === true;
    const maxPages = Number(strFlag(ctx.flags, 'maxPages') ?? 500);
    const withIssueSeverity = serverSeverityFilter(minSeverity, fullScan);

    const items: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    let pages = 0;
    let capped = false;
    for (;;) {
      if (pages >= maxPages) {
        capped = true;
        break;
      }
      ctx.progress(`· 正在拉取第 ${pages + 1} 页 listing...`);
      const resp = (await ctx.client.get(
        `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
        {
          marketplaceIds: mkt.id,
          includedData: 'summaries,issues',
          pageSize: 20,
          ...(withIssueSeverity ? { withIssueSeverity } : {}),
          ...(pageToken ? { pageToken } : {}),
        },
        mkt.region,
      )) as {
        pagination?: { nextToken?: string };
        items?: Array<Record<string, unknown>>;
      };
      items.push(...(resp.items ?? []));
      pages++;
      pageToken = resp.pagination?.nextToken;
      if (!pageToken) break;
    }

    const summary = summarizeListingIssues(items, minSeverity);
    const base = {
      marketplace: mkt.country,
      severity: minSeverity,
      scan: fullScan ? 'full' : `withIssueSeverity=${withIssueSeverity ?? 'none'}`,
      pagesFetched: pages,
      scanned: items.length,
      ...(capped ? { capped: true, note: `已到 --max-pages(${maxPages})上限,可能未拉全;加大 --max-pages 或用 --out 分批。` } : {}),
      counts: summary.counts,
    };

    const out = strFlag(ctx.flags, 'out');
    if (out) {
      writeFileSync(out, JSON.stringify({ ...base, rows: summary.rows }, null, 2), 'utf8');
      return { ...base, out, note: `完整 ${summary.rows.length} 行已写入 ${out}` };
    }
    return { ...base, rows: summary.rows };
  },
};
