// ads report —— 广告报表(V3 统一报表,异步:创建 → 轮询 → 下载)
//
// 依据(2026-07-13 官方 Postman 集合逐字核实,amzn/ads-advanced-tools-docs):
//   POST /reporting/reports
//     Content-Type: application/vnd.createasyncreportrequest.v3+json
//     body: {name, startDate, endDate,
//            configuration: {adProduct, groupBy, columns, reportTypeId, timeUnit, format}}
//   GET  /reporting/reports/{reportId}   查状态(同样的 vendor content-type)
//   状态流转:PENDING → PROCESSING → COMPLETED(官方 issue #348/#340 印证)
//   COMPLETED 后响应带下载地址,GZIP_JSON = 下载后 gunzip 得 JSON
//
// 预设配置全部经真实账号实测(创建被亚马逊接受=合法);
// 未核实到权威定义的字段一律透传原始响应,不做猜测。

import type { AdsClient } from '../../internal/client/ads-client.js';
import { ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { fetchDocumentBuffer, strFlag, validateNumberFlag } from '../common.js';
import {
  ADS_REGION_FLAG,
  ADS_REPORT_MAX_DAYS,
  adsRegion,
  requireDate,
  requireProfileId,
  splitDateRange,
  validateReportWindow,
} from './common.js';

// 官方 Postman 示例的默认列(SP campaigns 日报)
const DEFAULT_COLUMNS =
  'date,campaignId,adGroupId,impressions,clicks,cost,purchases1d,purchases7d,purchases14d,purchases30d';

/**
 * 报表类型预设:--type 支持语义别名,自动配好 reportTypeId/groupBy/columns。
 * 配置合法性已用真实账号实测验证(2026-07-14,创建均被亚马逊接受)。
 * 也可直接传原始 reportTypeId(如 spAdvertisedProduct)并自带 --columns。
 */
const REPORT_PRESETS: Record<
  string,
  { reportTypeId: string; groupBy: string; columns: string; desc: string }
> = {
  campaigns: {
    reportTypeId: 'spCampaigns',
    groupBy: 'campaign,adGroup',
    columns: DEFAULT_COLUMNS,
    desc: '广告活动层花费日报',
  },
  'search-terms': {
    reportTypeId: 'spSearchTerm',
    groupBy: 'searchTerm',
    columns: 'date,campaignId,adGroupId,searchTerm,impressions,clicks,cost,purchases7d,sales7d',
    desc: '买家搜索词报表',
  },
  targeting: {
    reportTypeId: 'spTargeting',
    groupBy: 'targeting',
    columns: 'date,campaignId,adGroupId,keyword,matchType,impressions,clicks,cost,purchases7d,sales7d',
    desc: '关键词/定向表现报表',
  },
  'advertised-products': {
    reportTypeId: 'spAdvertisedProduct',
    groupBy: 'advertiser',
    columns:
      'date,campaignId,adGroupId,advertisedAsin,advertisedSku,impressions,clicks,cost,purchases7d,sales7d',
    desc: '广告商品报表(每个被投广告的 ASIN/SKU 的表现)',
  },
  'purchased-products': {
    reportTypeId: 'spPurchasedProduct',
    groupBy: 'asin',
    columns: 'date,campaignId,adGroupId,advertisedAsin,purchasedAsin,purchases7d,sales7d',
    desc: '购买商品报表(广告点击后实际买了什么,含关联购买)',
  },
};

export interface AdsReportConfig {
  reportTypeId: string;
  groupBy: string[];
  columns: string[];
  start: string;
  end: string;
  desc?: string;
}

/** 从 flag 组装报表配置(供 ads report-run 用;导出仅为单测)。 */
export function adsConfigFromFlags(ctx: Pick<ToolContext, 'flags'>): AdsReportConfig {
  const start = requireDate(ctx.flags, 'start', '--start');
  const end = requireDate(ctx.flags, 'end', '--end');
  const typeFlag = (strFlag(ctx.flags, 'type') ?? 'campaigns').trim();
  const preset = REPORT_PRESETS[typeFlag.toLowerCase()];
  const reportTypeId = preset?.reportTypeId ?? typeFlag;
  // split 后 trim + 过滤空项:"a,,b" 或首尾逗号不能把空字符串传给 API
  const columns = (strFlag(ctx.flags, 'columns') ?? preset?.columns ?? DEFAULT_COLUMNS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const groupBy = (strFlag(ctx.flags, 'groupBy') ?? preset?.groupBy ?? 'campaign,adGroup')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { reportTypeId, groupBy, columns, start, end, desc: preset?.desc };
}

/** --report-id 缺失或空串时抛类型化参数错误,避免拼出 /reports/undefined。 */
function requireReportId(flags: Record<string, unknown>): string {
  const reportId = strFlag(flags, 'reportId');
  if (!reportId) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.missing_report_id',
      param: '--report-id',
      hintAgent: 'fix_param',
      hintHuman: '--report-id 不能为空,请传入 ads report-run 返回的报表编号。',
      message: '--report-id is required and must not be empty',
    });
  }
  return reportId;
}

/** 从 425 响应文本里抠出原报表 ID(UUID);抠不到返回 undefined。 */
export function extractDuplicateReportId(message: string): string | undefined {
  return /duplicate of\s*:?\s*\\?"?([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})/.exec(
    message,
  )?.[1];
}

async function createReport(ctx: ToolContext, profileId: string, cfg: AdsReportConfig): Promise<string> {
  ctx.progress(`· 正在创建广告报表(${cfg.desc ?? cfg.reportTypeId},${cfg.start} ~ ${cfg.end})...`);
  let resp: { reportId?: string } | null;
  try {
    resp = await requestCreateReport(ctx, profileId, cfg);
  } catch (err) {
    // 同配置+同日期的报表几分钟内重复创建,亚马逊回 425 并附原报表 ID——
    // 直接复用它继续轮询下载,不让"刚查过一次"变成报错。
    const dupId =
      err instanceof AmzError && err.subtype === 'ads.duplicate_request'
        ? extractDuplicateReportId(err.message)
        : undefined;
    if (!dupId) throw err;
    ctx.progress(`· 同配置报表几分钟前刚创建过,复用已有报表 ${dupId}...`);
    return dupId;
  }

  if (!resp?.reportId) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'ads.report_no_id',
      hintAgent: 'report_to_human',
      hintHuman: '广告报表创建请求已发出,但亚马逊没有返回报表编号,原始响应见 message。',
      message: `createReport returned: ${JSON.stringify(resp).slice(0, 500)}`,
    });
  }
  return resp.reportId;
}

async function requestCreateReport(
  ctx: ToolContext,
  profileId: string,
  cfg: AdsReportConfig,
): Promise<{ reportId?: string } | null> {
  return (await ctx.adsClient.request('POST', '/reporting/reports', {
    profileId,
    region: adsRegion(ctx.flags),
    contentType: ADS_CONTENT_TYPES.createReport,
    body: {
      name: `amz-cli report ${cfg.start}~${cfg.end}`,
      startDate: cfg.start,
      endDate: cfg.end,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: cfg.groupBy,
        columns: cfg.columns,
        reportTypeId: cfg.reportTypeId,
        timeUnit: 'DAILY',
        format: 'GZIP_JSON',
      },
    },
  })) as { reportId?: string } | null;
}

/**
 * 一条龙拉广告报表并返回解析后的行数组(创建 → 轮询 → 下载 → JSON.parse)。
 * 供聚合类命令(如 ads wasted-spend)复用;拿不到下载地址时抛类型化错误。
 *
 * 跨度超过单张 31 天上限时自动分段:每段一张报表,行数组按段拼接。
 * 下游都是"天级明细再汇总"的用法,拼接不改变语义。先把所有段的创建请求发完
 * (亚马逊并行生成),再逐段等待下载,总耗时≈最慢的一段;timeoutMin 按段计。
 */
export async function fetchAdsReportRows(
  ctx: ToolContext,
  profileId: string,
  cfg: AdsReportConfig,
  timeoutMin: number,
): Promise<Array<Record<string, unknown>>> {
  const segments = splitDateRange(cfg.start, cfg.end);
  // start > end 时 splitDateRange 返回空数组 —— 就这么走下去会"成功返回 0 行",
  // 而"没有废词"和"日期传反了"在下游看起来一模一样。入口的 validateReportWindow
  // 已经拦了这种情况,这里是给绕过校验的调用方(新命令/MCP 路径)兜底,宁可报错。
  if (segments.length === 0) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.empty_date_range',
      param: '--start',
      hintAgent: 'fix_param',
      hintHuman: `日期区间为空(--start ${cfg.start} 晚于 --end ${cfg.end}),请检查日期顺序。`,
      message: `empty date range: ${cfg.start} ~ ${cfg.end}`,
    });
  }
  if (segments.length > 1) {
    ctx.progress(
      `· 日期跨度超过单张报表 ${ADS_REPORT_MAX_DAYS} 天上限,自动分成 ${segments.length} 段拉取合并...`,
    );
  }
  const reportIds: string[] = [];
  for (const seg of segments) {
    reportIds.push(await createReport(ctx, profileId, { ...cfg, start: seg.start, end: seg.end }));
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const reportId of reportIds) {
    const status = await waitForAdsReport(ctx, profileId, reportId, timeoutMin);
    const url = typeof status['url'] === 'string' ? (status['url'] as string) : undefined;
    if (!url) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'ads.report_no_url',
        hintAgent: 'report_to_human',
        hintHuman: '广告报表已完成但响应里没有下载地址,请稍后重试或用 ads report-status 查看原始响应。',
        message: `ads report ${reportId} completed without url: ${JSON.stringify(status).slice(0, 500)}`,
      });
    }
    ctx.progress('· 报表已生成,正在下载解析...');
    const buf = await fetchDocumentBuffer(url, {
      gzip: true,
      what: '广告报表',
      subtype: 'ads.report_download_failed',
      // 广告报表走广告的出口(ADS_PROXY;留空则复用 SP_API_PROXY)
      channel: 'ads',
    });
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (Array.isArray(parsed)) rows.push(...(parsed as Array<Record<string, unknown>>));
  }
  return rows;
}

async function getReportStatus(
  client: AdsClient,
  profileId: string,
  reportId: string,
  region?: 'na' | 'eu' | 'fe',
): Promise<Record<string, unknown>> {
  return ((await client.request('GET', `/reporting/reports/${encodeURIComponent(reportId)}`, {
    profileId,
    region,
    contentType: ADS_CONTENT_TYPES.createReport,
  })) ?? {}) as Record<string, unknown>;
}

/** 轮询直到 COMPLETED(返回状态对象)或失败/超时(抛类型化错误)。 */
async function waitForAdsReport(
  ctx: ToolContext,
  profileId: string,
  reportId: string,
  timeoutMin: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  for (;;) {
    const status = await getReportStatus(ctx.adsClient, profileId, reportId, adsRegion(ctx.flags));
    const state = String(status['status'] ?? '').toUpperCase();

    if (state === 'COMPLETED') return status;

    // EXPIRED 也是终态:报表过期后既不会变 COMPLETED,状态名里也不含 FAIL/CANCEL/ERROR,
    // 漏掉它就会空转到 timeout(默认 10 分钟)才报"超时",而真因是"这张报表已经没了"。
    // 撞 425 复用几分钟前的旧报表时最容易碰上,所以必须显式认这个终态。
    if (
      state === 'EXPIRED' ||
      state.includes('FAIL') ||
      state.includes('CANCEL') ||
      state.includes('ERROR')
    ) {
      const expired = state === 'EXPIRED';
      throw new AmzError({
        type: 'upstream_error',
        subtype: expired ? 'ads.report_expired' : 'ads.report_failed',
        // EXPIRED 刻意**不**标可重试:它最常见的来源就是上面 425 去重复用到的旧报表,
        // 而立刻重试会用同样的 body 再撞一次 425、再拿回同一张过期报表 —— Agent 会
        // 就此陷入死循环。必须等去重窗口过去(几分钟)才可能建出新报表。
        hintAgent: 'report_to_human',
        hintHuman: expired
          ? `报表 ${reportId} 已过期(亚马逊侧的报表有保留期)。` +
            '注意:如果这是刚才重复创建时被"去重"复用到的旧报表,立刻重试只会再次命中同一张,' +
            '请等几分钟(去重窗口过去)再执行,或改一下日期范围以生成一张全新的报表。'
          : `广告报表生成失败(状态 ${state}),原始响应见 message。`,
        message: `ads report ${reportId} ended in state ${state}: ${JSON.stringify(status).slice(0, 800)}`,
        retryable: false,
      });
    }

    if (Date.now() >= deadline) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'ads.report_timeout',
        hintAgent: 'backoff_and_retry',
        hintHuman: `报表 ${timeoutMin} 分钟内未生成完(当前状态 ${state || '未知'})。可稍后用 ads report-status --report-id ${reportId} 继续查。`,
        message: `ads report ${reportId} still ${state} after ${timeoutMin}min`,
        retryable: true,
      });
    }
    ctx.progress(`· 报表状态:${state || '未知'},15 秒后再查...`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/** 从 COMPLETED 状态对象取下载地址并下载解析(GZIP_JSON)。 */
async function downloadAdsReport(
  ctx: ToolContext,
  reportId: string,
  status: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 下载地址字段:透传优先,常见为 url(未逐字核实,故兜底给出完整响应)
  const url = typeof status['url'] === 'string' ? (status['url'] as string) : undefined;
  if (!url) {
    return {
      reportId,
      note: '报表已完成,但响应中没有可识别的下载地址字段——完整原始响应如下,请人工确认',
      raw: status,
    };
  }
  ctx.progress('· 报表已生成,正在下载解析...');
  const buf = await fetchDocumentBuffer(url, {
    gzip: true,
    what: '广告报表',
    subtype: 'ads.report_download_failed',
    // 广告报表走广告的出口(ADS_PROXY;留空则复用 SP_API_PROXY)
    channel: 'ads',
  });
  const rows = JSON.parse(buf.toString('utf8')) as unknown[];
  return { reportId, rowCount: Array.isArray(rows) ? rows.length : undefined, rows };
}

export const adsReportStatus: ToolDefinition = {
  service: 'ads',
  command: 'report-status',
  description: '查询广告报表生成进度(状态与原始响应透传)',
  mutation: 'none',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'report-id', desc: 'ads report-run 返回的报表编号(必填)', required: true },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    requireReportId(flags);
  },
  execute: async (ctx) => {
    return getReportStatus(ctx.adsClient, requireProfileId(ctx.flags), requireReportId(ctx.flags), adsRegion(ctx.flags));
  },
};

export const adsReportRun: ToolDefinition = {
  service: 'ads',
  command: 'report-run',
  description:
    '一条龙拉广告报表(SP 商品推广):创建 → 轮询 → 下载解析。默认 spCampaigns 日报(曝光/点击/花费/转化)',
  mutation: 'none',
  isAsync: true,
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填,ads profiles 可查)', required: true },
    ADS_REGION_FLAG,
    { name: 'start', desc: '开始日期 YYYY-MM-DD(必填;数据只保留约 95 天)', required: true },
    { name: 'end', desc: '结束日期 YYYY-MM-DD(必填;单张报表最多 31 天,更长请分段或用 ads performance / wasted-spend 自动分段)', required: true },
    {
      name: 'type',
      desc:
        '报表类型,默认 campaigns。预设:campaigns(花费日报)| search-terms(买家搜索词)| targeting(关键词表现)| advertised-products(广告商品)| purchased-products(购买商品);也可传原始 reportTypeId',
    },
    { name: 'columns', desc: '返回列,逗号分隔(不传则用预设的推荐列)' },
    { name: 'group-by', desc: '分组维度,逗号分隔(不传则用预设值)' },
    { name: 'timeout', desc: '最长等待分钟数,默认 10' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    // 单张原始报表没法自动分段合并,跨度>31 天本地直接拦下并提示怎么拆
    validateReportWindow(flags, { maxDays: ADS_REPORT_MAX_DAYS });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const reportId = await createReport(ctx, profileId, adsConfigFromFlags(ctx));
    const timeoutMin = Number(strFlag(ctx.flags, 'timeout') ?? 10);
    const status = await waitForAdsReport(ctx, profileId, reportId, timeoutMin);
    return downloadAdsReport(ctx, reportId, status);
  },
};
