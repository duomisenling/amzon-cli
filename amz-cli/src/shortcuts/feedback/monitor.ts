// feedback run —— 卖家反馈监控(差评/中评)
//
// 复用 report 的异步链路设施,报告类型固定 GET_SELLER_FEEDBACK_DATA。
// API 限制(规格 §7.1 已注明):这份报告只包含 1-3 星(差评+中评),
// 拿不到 4-5 星好评——这是亚马逊本身的限制,不是 CLI 的问题。
// 报告是 TSV,列名由亚马逊定；输出前按官方字段定义删除 Rater Email。

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { daysAgoIso, resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import {
  downloadReportDocument,
  parseReport,
  requestReport,
  requireReportDocumentId,
  waitForReport,
} from '../report/infra.js';
import { sanitizeReportText } from '../report/sanitize.js';

export const feedbackRun: ToolDefinition = {
  service: 'feedback',
  command: 'run',
  description: '拉取卖家反馈报告(仅 1-3 星差评中评;默认最近 30 天)',
  mutation: 'none',
  isAsync: true,
  roles: ['Selling Partner Insights'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'days', desc: '查最近 N 天,默认 30' },
    { name: 'timeout', desc: '最长等待分钟数,默认 10' },
  ],
  validate: (flags) => {
    validateNumberFlag(flags, 'days', '--days', { min: 1, max: 365, integer: true });
    validateNumberFlag(flags, 'timeout', '--timeout', { min: 1, max: 60 });
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const days = Number(strFlag(ctx.flags, 'days') ?? 30);
    const start = daysAgoIso(days);

    let downloaded: string;
    try {
      const reportId = await requestReport(ctx, 'GET_SELLER_FEEDBACK_DATA', mkt, {
        dataStartTime: start,
      });
      const status = await waitForReport(ctx, reportId, Number(strFlag(ctx.flags, 'timeout') ?? 10), mkt.region);
      downloaded = await downloadReportDocument(ctx, requireReportDocumentId(status), mkt.region);
    } catch (error) {
      // 期间没有 1-3 星反馈时亚马逊会 CANCELLED——不是故障,当作"无差评中评"的正常结果
      // (与 inventory aged/stranded 等同类报告命令的处理对齐)。
      if (error instanceof AmzError && error.subtype === 'report.cancelled') {
        return {
          marketplace: mkt.country,
          days,
          note: `最近 ${days} 天没有 1-3 星反馈(报告为空)。注意此报告本身只含 1-3 星,拿不到好评。`,
          totalRows: 0,
          feedback: [],
        };
      }
      throw error;
    }
    const text = sanitizeReportText('GET_SELLER_FEEDBACK_DATA', downloaded);
    const parsed = parseReport(text, 1000);

    if (parsed.format === 'raw') {
      return { marketplace: mkt.country, days, format: 'raw', content: parsed.rawText };
    }
    return {
      marketplace: mkt.country,
      days,
      note: '此报告仅含 1-3 星反馈(亚马逊 API 限制,无法获取好评)',
      totalRows: parsed.rowCount,
      headers: parsed.headers,
      feedback: parsed.rows,
    };
  },
};
