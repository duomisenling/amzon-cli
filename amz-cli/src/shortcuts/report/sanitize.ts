import { AmzError } from '../../internal/errs/errors.js';

// 个别报告特有的敏感列(通用黑名单之外的补充)。
const SENSITIVE_COLUMNS_BY_REPORT = new Map<string, Set<string>>([
  ['GET_SELLER_FEEDBACK_DATA', new Set(['rater email'])],
]);

/**
 * 已确认含买家 PII 的报告类型。这些类型必须是可解析的 TSV,否则失败关闭:
 * XML 订单类报告(GET_ORDER_REPORT_DATA_*)整个是买家收件信息,无法按列删除,
 * 一律拒绝输出 —— 与 orders 命令的白名单红线保持同一原则。
 */
const PII_REPORT_TYPES = new Set([
  'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL',
  'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_INVOICING',
  'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_TAX',
  'GET_FLAT_FILE_ORDER_REPORT_DATA_INVOICING',
  'GET_FLAT_FILE_ORDER_REPORT_DATA_SHIPPING',
  'GET_FLAT_FILE_ORDER_REPORT_DATA_TAX',
  'GET_FLAT_FILE_ORDERS_RECONCILIATION_DATA',
  'GET_ORDER_REPORT_DATA_INVOICING',
  'GET_ORDER_REPORT_DATA_SHIPPING',
  'GET_ORDER_REPORT_DATA_TAX',
  'GET_SELLER_FEEDBACK_DATA',
]);

/**
 * 买家 PII 列的通用黑名单,对**所有** TSV 报告生效(不限报告类型):
 * 报告通道能下载任意类型,逐类型登记必然滞后,按列名兜底才拦得住。
 * 列名先归一化(小写、_/- 折成空格)再匹配。
 * 保留 city/state/邮编/国家 —— 物流分析需要,且姓名地址行删除后可识别性已大幅降低。
 */
const PII_COLUMNS = new Set([
  'buyer email',
  'buyer name',
  'buyer phone number',
  'recipient name',
  'recipient email',
  'rater email',
  'ship address 1',
  'ship address 2',
  'ship address 3',
  'ship phone number',
  'bill address 1',
  'bill address 2',
  'bill address 3',
]);

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * 删除官方报告中的买家 PII 列。
 *
 * 两层防线:已知含 PII 的报告类型要求必须是 TSV(否则失败关闭,不把原文交给
 * Agent 或写入文件);在此之外,任何 TSV 报告的列名命中通用黑名单也会被删,
 * 不依赖报告类型登记齐全。
 */
export function sanitizeReportText(reportType: string | undefined, text: string): string {
  const normalizedType = reportType?.toUpperCase();
  const extraSensitive = normalizedType
    ? SENSITIVE_COLUMNS_BY_REPORT.get(normalizedType)
    : undefined;
  const mustBeTsv = normalizedType !== undefined && PII_REPORT_TYPES.has(normalizedType);
  if (text.length === 0) return text;

  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? '';
  if (!header.includes('\t')) {
    if (mustBeTsv) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'report.sensitive_format_unrecognized',
        hintAgent: 'report_to_human',
        hintHuman:
          `${reportType} 属于含买家个人信息的报告,但 Amazon 返回的内容不是预期的 TSV 格式。` +
          '为避免泄露买家个人信息,CLI 已拒绝输出或保存原文。' +
          '如需订单数据请改用 orders 命令(已做脱敏),或请管理员核对报告格式。',
        message: `sensitive report ${reportType} is not a tab-delimited document`,
      });
    }
    return text; // 非 TSV 且不在已知 PII 清单里(如纯文本/JSON 类报告),原样返回
  }

  const headers = header.split('\t');
  const keptIndexes = headers
    .map((value, index) => ({ index, normalized: normalizedHeader(value) }))
    .filter(({ normalized }) => !PII_COLUMNS.has(normalized) && !extraSensitive?.has(normalized))
    .map(({ index }) => index);

  if (keptIndexes.length === headers.length) return text;
  return lines
    .map((line) => {
      const cells = line.split('\t');
      return keptIndexes.map((index) => cells[index] ?? '').join('\t');
    })
    .join('\n');
}
