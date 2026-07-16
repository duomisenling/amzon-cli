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
import { ADS_REGION_FLAG, adsRegion, requireDate, requireProfileId } from './common.js';

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

async function createReport(ctx: ToolContext, profileId: string): Promise<string> {
  const start = requireDate(ctx.flags, 'start', '--start');
  const end = requireDate(ctx.flags, 'end', '--end');

  const typeFlag = (strFlag(ctx.flags, 'type') ?? 'campaigns').trim();
  const preset = REPORT_PRESETS[typeFlag.toLowerCase()];
  const reportTypeId = preset?.reportTypeId ?? typeFlag;
  const columns = (strFlag(ctx.flags, 'columns') ?? preset?.columns ?? DEFAULT_COLUMNS)
    .split(',')
    .map((s) => s.trim());
  const groupBy = (strFlag(ctx.flags, 'groupBy') ?? preset?.groupBy ?? 'campaign,adGroup')
    .split(',')
    .map((s) => s.trim());

  ctx.progress(`· 正在创建广告报表(${preset ? preset.desc : reportTypeId},${start} ~ ${end})...`);
  const resp = (await ctx.adsClient.request('POST', '/reporting/reports', {
    profileId,
    region: adsRegion(ctx.flags),
    contentType: ADS_CONTENT_TYPES.createReport,
    body: {
      name: `amz-cli report ${start}~${end}`,
      startDate: start,
      endDate: end,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy,
        columns,
        reportTypeId,
        timeUnit: 'DAILY',
        format: 'GZIP_JSON',
      },
    },
  })) as { reportId?: string } | null;

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

    if (state.includes('FAIL') || state.includes('CANCEL') || state.includes('ERROR')) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'ads.report_failed',
        hintAgent: 'report_to_human',
        hintHuman: `广告报表生成失败(状态 ${state}),原始响应见 message。`,
        message: `ads report ${reportId} failed: ${JSON.stringify(status).slice(0, 800)}`,
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
  execute: async (ctx) => {
    return getReportStatus(ctx.adsClient, requireProfileId(ctx.flags), strFlag(ctx.flags, 'reportId')!, adsRegion(ctx.flags));
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
    { name: 'start', desc: '开始日期 YYYY-MM-DD(必填)', required: true },
    { name: 'end', desc: '结束日期 YYYY-MM-DD(必填)', required: true },
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
    requireDate(flags, 'start', '--start');
    requireDate(flags, 'end', '--end');
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const reportId = await createReport(ctx, profileId);
    const timeoutMin = Number(strFlag(ctx.flags, 'timeout') ?? 10);
    const status = await waitForAdsReport(ctx, profileId, reportId, timeoutMin);
    return downloadAdsReport(ctx, reportId, status);
  },
};
