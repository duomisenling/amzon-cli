// Reports API 异步链路设施:createReport → 轮询 → 下载 → 解析
//
// API: Reports API 2021-06-30(2026-07-13 从官方 OpenAPI 规范核实)
//   POST /reports/2021-06-30/reports            限速 0.0167/s, burst 15
//   GET  /reports/2021-06-30/reports/{reportId} 限速 2/s(轮询走这个,安全)
//   GET  /reports/2021-06-30/documents/{docId}  限速 0.0167/s, burst 15
//   文档 url 是 5 分钟有效的预签名地址,可能 GZIP 压缩
//   processingStatus 枚举:IN_QUEUE / IN_PROGRESS / DONE / CANCELLED / FATAL
//   注意:CANCELLED 不一定是错——报告期间无数据时亚马逊也会返回 CANCELLED

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext } from '../../tools/types.js';
import type { MarketplaceInfo, Region } from '../../internal/client/regions.js';
import { fetchDocumentBuffer } from '../common.js';

export interface ReportStatus {
  reportId: string;
  reportType?: string;
  processingStatus: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL';
  reportDocumentId?: string;
  createdTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
}

/** 发起报告请求,返回 reportId。 */
export async function requestReport(
  ctx: ToolContext,
  reportType: string,
  marketplace: MarketplaceInfo,
  opts: { dataStartTime?: string; dataEndTime?: string } = {},
): Promise<string> {
  ctx.progress(`· 正在请求报告 ${reportType}(${marketplace.country})...`);
  const resp = (await ctx.client.request('POST', '/reports/2021-06-30/reports', {
    region: marketplace.region,
    body: {
      reportType,
      marketplaceIds: [marketplace.id],
      ...(opts.dataStartTime ? { dataStartTime: opts.dataStartTime } : {}),
      ...(opts.dataEndTime ? { dataEndTime: opts.dataEndTime } : {}),
    },
  })) as { reportId?: string };
  if (!resp.reportId) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'report.no_report_id',
      hintAgent: 'report_to_human',
      hintHuman: '亚马逊接受了报告请求但没有返回报告编号,请稍后重试。',
      message: `createReport returned no reportId: ${JSON.stringify(resp)}`,
    });
  }
  return resp.reportId;
}

/** 查询报告状态。 */
export async function getReportStatus(
  ctx: ToolContext,
  reportId: string,
  region?: Region,
): Promise<ReportStatus> {
  const resp = (await ctx.client.get(
    `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
    undefined,
    region,
  )) as ReportStatus;
  return resp;
}

/**
 * 轮询直到报告完成(DONE)或终态失败。
 * 间隔 15s(远低于 getReport 的 2/s 限速),默认最长等 10 分钟。
 */
export async function waitForReport(
  ctx: ToolContext,
  reportId: string,
  timeoutMinutes = 10,
  region?: Region,
): Promise<ReportStatus> {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  const intervalMs = 15_000;
  for (;;) {
    const status = await getReportStatus(ctx, reportId, region);
    switch (status.processingStatus) {
      case 'DONE':
        ctx.progress(`· 报告已生成(reportId=${reportId})`);
        return status;
      case 'FATAL': {
        // 官方机制:FATAL 报告若带 reportDocumentId,该文档内容就是失败原因说明
        let reason = '';
        if (status.reportDocumentId) {
          reason = await downloadReportDocument(ctx, status.reportDocumentId, region)
            .then((t) => t.slice(0, 500))
            .catch(() => '');
        }
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'report.fatal',
          hintAgent: 'report_to_human',
          hintHuman:
            '亚马逊生成这份报告时出错(FATAL)。' +
            (reason
              ? `亚马逊给出的原因:${reason}`
              : '已知常见原因:①该报告类型需要提供开始时间(--start);②短时间内重复请求了同类型报告——等一段时间(如几小时)再试。'),
          message: `report ${reportId} ended with FATAL${reason ? `: ${reason}` : ''}`,
        });
      }
      case 'CANCELLED':
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'report.cancelled',
          hintAgent: 'report_to_human',
          hintHuman: '报告被亚马逊取消(CANCELLED)。常见原因:所选时间范围内没有数据——这不一定是故障。',
          message: `report ${reportId} was CANCELLED (often means: no data in range)`,
        });
      default: {
        if (Date.now() >= deadline) {
          throw new AmzError({
            type: 'upstream_error',
            subtype: 'report.timeout',
            hintAgent: 'backoff_and_retry',
            hintHuman: `报告 ${timeoutMinutes} 分钟内还没生成完(当前状态 ${status.processingStatus})。可以稍后用 report status --report-id ${reportId} 继续查,或用 report download 拿结果。`,
            message: `report ${reportId} still ${status.processingStatus} after ${timeoutMinutes}min`,
            retryable: true,
          });
        }
        ctx.progress(`· 报告状态:${status.processingStatus},15 秒后再查...`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
}

export interface ParsedReport {
  format: 'tsv' | 'raw';
  headers?: string[];
  rows?: Array<Record<string, string>>;
  rowCount?: number;
  rawText?: string;
}

/** 下载报告文档并解析(处理 GZIP;flat file 报告按 TSV 解析,失败则原样返回)。 */
export async function downloadReportDocument(
  ctx: ToolContext,
  reportDocumentId: string,
  region?: Region,
): Promise<string> {
  ctx.progress('· 正在获取报告下载地址...');
  const doc = (await ctx.client.get(
    `/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`,
    undefined,
    region,
  )) as { url?: string; compressionAlgorithm?: string };
  if (!doc.url) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'report.no_document_url',
      hintAgent: 'report_to_human',
      hintHuman: '亚马逊没有返回报告下载地址,请稍后重试。',
      message: `getReportDocument returned no url: ${JSON.stringify(doc)}`,
    });
  }

  ctx.progress('· 正在下载报告内容...');
  const buf = await fetchDocumentBuffer(doc.url, {
    gzip: doc.compressionAlgorithm === 'GZIP',
    what: '报告',
    subtype: 'report.download_failed',
  });
  return decodeReportText(buf);
}

/** 报告文本解码:优先 UTF-8,出现替换符则回退 latin1(亚马逊 flat file 常见 cp1252)。 */
function decodeReportText(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

/** 把 flat file 报告解析成 {headers, rows};不是表格格式则原样返回。 */
export function parseReport(text: string, maxRows: number): ParsedReport {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { format: 'raw', rawText: '', rowCount: 0 };
  const headerLine = lines[0]!;
  if (!headerLine.includes('\t')) {
    // 不是 TSV(可能是 XML/CSV 等):原样返回,交给调用方
    return { format: 'raw', rawText: text.slice(0, 100_000), rowCount: lines.length };
  }
  const headers = headerLine.split('\t').map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const cells = lines[i]!.split('\t');
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return { format: 'tsv', headers, rows, rowCount: lines.length - 1 };
}
