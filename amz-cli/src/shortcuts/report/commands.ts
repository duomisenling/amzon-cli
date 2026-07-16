// report 命令组:types / create / status / download / run
//
// run 是规格 §4 说的"异步 Report 组合命令(含轮询)":
//   create → 轮询到 DONE → 下载 → 解析,一条命令走完。
// create/status/download 是拆开的单步命令,供 Agent 处理超长报告
// (先 create 拿 reportId,过几分钟再 status/download,不用挂着等)。

import { writeFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { OPTIONAL_MARKETPLACE_FLAG, daysAgoIso, optionalRegion, resolveMarketplace, strFlag, validateIsoTimeRange, validateNumberFlag } from '../common.js';
import type { Region } from '../../internal/client/regions.js';
import {
  downloadReportDocument,
  getReportStatus,
  parseReport,
  requestReport,
  waitForReport,
} from './infra.js';
import { sanitizeReportText } from './sanitize.js';

// 已知"必须传 dataStartTime 否则 FATAL"的报告类型。
// 官方文档标注可选,但实测(2026-07-13,真实账号)不传必 FATAL 且无错误说明;
// 社区亦有相同报告(amzn/selling-partner-api-models issues #2021/#4032)。
// 命中这些类型且用户没给 --start 时,自动默认 24 小时前。
const REQUIRES_START_TIME = new Set([
  'GET_FBA_MYI_ALL_INVENTORY_DATA',
  'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
]);

/** 解析 --start:命中已知必填类型且未提供时,补默认值(24h 前)并提示。 */
function resolveStartTime(
  reportType: string,
  start: string | undefined,
  progress: (msg: string) => void,
): string | undefined {
  if (start || !REQUIRES_START_TIME.has(reportType)) return start;
  const fallback = daysAgoIso(1);
  progress(`· 该报告类型必须提供开始时间(亚马逊的隐性要求),已自动使用 24 小时前:${fallback}`);
  return fallback;
}

// 常用报告类型(2026-07-13 从官方 report-type-values 文档核实;
// 完整清单见 https://developer-docs.amazon.com/sp-api/docs/report-type-values)
const COMMON_REPORT_TYPES: Array<{ type: string; desc: string }> = [
  { type: 'GET_MERCHANT_LISTINGS_ALL_DATA', desc: '全部商品列表(活跃+非活跃,含 SKU/ASIN/价格/数量)' },
  { type: 'GET_MERCHANT_LISTINGS_DATA', desc: '活跃商品列表' },
  { type: 'GET_MERCHANT_LISTINGS_INACTIVE_DATA', desc: '非活跃商品列表' },
  { type: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', desc: 'FBA 可售库存' },
  { type: 'GET_FBA_MYI_ALL_INVENTORY_DATA', desc: 'FBA 全部库存(含不可售)' },
  { type: 'GET_FBA_INVENTORY_PLANNING_DATA', desc: 'FBA 库存健康/规划(库龄等)' },
  { type: 'GET_AFN_INVENTORY_DATA', desc: 'FBA 库存快照' },
  { type: 'GET_SELLER_FEEDBACK_DATA', desc: '卖家反馈(仅 1-3 星差评中评,API 限制拿不到好评)' },
];

export const reportTypes: ToolDefinition = {
  service: 'report',
  command: 'types',
  description: '列出常用报告类型(不调 API)',
  mutation: 'none',
  flags: [],
  execute: async () => ({ reportTypes: COMMON_REPORT_TYPES }),
};

export const reportCreate: ToolDefinition = {
  service: 'report',
  command: 'create',
  description: '发起报告请求,立即返回 reportId(之后用 report status / download 跟进)',
  mutation: 'none', // 只是请求生成一份数据,不改任何业务数据
  roles: ['Inventory and Order Tracking / Selling Partner Insights(视报告类型)'],
  flags: [
    { name: 'type', desc: '报告类型,如 GET_MERCHANT_LISTINGS_ALL_DATA(见 report types)', required: true },
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'start', desc: '数据开始时间,ISO 8601(可选,默认由亚马逊定)' },
    { name: 'end', desc: '数据结束时间,ISO 8601(可选)' },
  ],
  validate: (flags) => {
    validateIsoTimeRange(flags);
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const type = strFlag(ctx.flags, 'type')!;
    const reportId = await requestReport(ctx, type, mkt, {
      dataStartTime: resolveStartTime(type, strFlag(ctx.flags, 'start'), ctx.progress),
      dataEndTime: strFlag(ctx.flags, 'end'),
    });
    return {
      reportId,
      next: `用 report status --report-id ${reportId} 查进度;DONE 后用 report download --report-id ${reportId} 取内容`,
    };
  },
};

export const reportStatus: ToolDefinition = {
  service: 'report',
  command: 'status',
  description: '查询报告生成进度',
  mutation: 'none',
  flags: [
    { name: 'report-id', desc: 'report create 返回的报告编号(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
  ],
  execute: async (ctx) => {
    return getReportStatus(ctx, strFlag(ctx.flags, 'reportId')!, optionalRegion(ctx.flags));
  },
};

/** download / run 共用的下载+解析+输出逻辑。 */
async function deliverReport(
  ctx: ToolContext,
  reportDocumentId: string,
  region?: Region,
  reportType?: string,
): Promise<Record<string, unknown>> {
  const downloaded = await downloadReportDocument(ctx, reportDocumentId, region);
  const text = sanitizeReportText(reportType, downloaded);

  const outPath = strFlag(ctx.flags, 'out');
  if (outPath) {
    writeFileSync(outPath, text, 'utf8');
    const lineCount = text.split(/\r?\n/).filter((l) => l.length > 0).length;
    return { savedTo: outPath, lines: lineCount };
  }

  const maxRows = Number(strFlag(ctx.flags, 'maxRows') ?? 1000);
  const parsed = parseReport(text, maxRows);
  if (parsed.format === 'raw') {
    return { format: 'raw', content: parsed.rawText, totalLines: parsed.rowCount };
  }
  return {
    format: 'tsv',
    headers: parsed.headers,
    totalRows: parsed.rowCount,
    returnedRows: parsed.rows!.length,
    ...(parsed.rowCount! > parsed.rows!.length
      ? { truncated: true, hint: '行数超出 --max-rows,完整内容请用 --out 保存到文件' }
      : {}),
    rows: parsed.rows,
  };
}

const DOWNLOAD_FLAGS = [
  { name: 'out', desc: '把原始报告存到这个文件路径(大报告建议用);不给则解析后直接输出' },
  { name: 'max-rows', desc: '直接输出时最多返回多少行,默认 1000' },
];

export const reportDownload: ToolDefinition = {
  service: 'report',
  command: 'download',
  description: '下载已生成(DONE)的报告并解析输出',
  mutation: 'none',
  flags: [
    { name: 'report-id', desc: '报告编号(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
    ...DOWNLOAD_FLAGS,
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'maxRows', '--max-rows', { min: 1, max: 100_000, integer: true });
  },
  execute: async (ctx) => {
    const reportId = strFlag(ctx.flags, 'reportId')!;
    const region = optionalRegion(ctx.flags);
    const status = await getReportStatus(ctx, reportId, region);
    if (status.processingStatus !== 'DONE' || !status.reportDocumentId) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'report.not_ready',
        param: '--report-id',
        hintAgent: 'backoff_and_retry',
        hintHuman: `报告还没生成完(当前状态 ${status.processingStatus}),请稍后再试,或用 report run 一条龙等待。`,
        message: `report ${reportId} is ${status.processingStatus}, not DONE`,
        retryable: status.processingStatus === 'IN_QUEUE' || status.processingStatus === 'IN_PROGRESS',
      });
    }
    return deliverReport(ctx, status.reportDocumentId, region, status.reportType);
  },
};

export const reportRun: ToolDefinition = {
  service: 'report',
  command: 'run',
  description: '一条龙:发起报告 → 轮询等待生成 → 下载解析(默认最长等 10 分钟)',
  mutation: 'none',
  isAsync: true,
  flags: [
    { name: 'type', desc: '报告类型,如 GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA(必填)', required: true },
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'start', desc: '数据开始时间,ISO 8601(可选)' },
    { name: 'end', desc: '数据结束时间,ISO 8601(可选)' },
    { name: 'timeout', desc: '最长等待分钟数,默认 10' },
    ...DOWNLOAD_FLAGS,
  ],
  validate: (flags) => {
    validateIsoTimeRange(flags);
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
    validateNumberFlag(flags, 'maxRows', '--max-rows', { min: 1, max: 100_000, integer: true });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const type = strFlag(ctx.flags, 'type')!;
    const reportId = await requestReport(ctx, type, mkt, {
      dataStartTime: resolveStartTime(type, strFlag(ctx.flags, 'start'), ctx.progress),
      dataEndTime: strFlag(ctx.flags, 'end'),
    });
    const timeout = Number(strFlag(ctx.flags, 'timeout') ?? 10);
    const status = await waitForReport(ctx, reportId, timeout, mkt.region);
    const data = await deliverReport(ctx, status.reportDocumentId!, mkt.region, type);
    return { reportId, reportType: type, marketplace: mkt.country, ...data };
  },
};
