import { AmzError } from '../../internal/errs/errors.js';

const SENSITIVE_COLUMNS_BY_REPORT = new Map<string, Set<string>>([
  ['GET_SELLER_FEEDBACK_DATA', new Set(['rater email'])],
]);

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * 删除官方报告中已确认的买家 PII 列。对已知敏感报告采用失败关闭：
 * 如果 Amazon 返回了无法识别的非 TSV 格式，不把原文交给 Agent 或写入文件。
 */
export function sanitizeReportText(reportType: string | undefined, text: string): string {
  const sensitive = reportType ? SENSITIVE_COLUMNS_BY_REPORT.get(reportType.toUpperCase()) : undefined;
  if (!sensitive || text.length === 0) return text;

  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? '';
  if (!header.includes('\t')) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'report.sensitive_format_unrecognized',
      hintAgent: 'report_to_human',
      hintHuman:
        `Amazon 返回的 ${reportType} 报告不是预期的 TSV 格式。` +
        '为避免泄露买家个人信息，CLI 已拒绝输出或保存原文，请管理员核对报告格式。',
      message: `sensitive report ${reportType} is not a tab-delimited document`,
    });
  }

  const headers = header.split('\t');
  const keptIndexes = headers
    .map((value, index) => ({ index, normalized: normalizedHeader(value) }))
    .filter(({ normalized }) => !sensitive.has(normalized))
    .map(({ index }) => index);

  if (keptIndexes.length === headers.length) return text;
  return lines
    .map((line) => {
      const cells = line.split('\t');
      return keptIndexes.map((index) => cells[index] ?? '').join('\t');
    })
    .join('\n');
}
