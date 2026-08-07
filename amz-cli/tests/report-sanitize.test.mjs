import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeReportText } from '../dist/shortcuts/report/sanitize.js';

test('feedback report removes the buyer email column and keeps operational fields aligned', () => {
  const input = [
    'Date\tRating\tComments\tOrder ID\tRater Email',
    '2026-07-01\t1\tBroken\t111-1111111-1111111\tbuyer@example.com',
  ].join('\r\n');

  const output = sanitizeReportText('GET_SELLER_FEEDBACK_DATA', input);
  assert.equal(
    output,
    ['Date\tRating\tComments\tOrder ID', '2026-07-01\t1\tBroken\t111-1111111-1111111'].join('\n'),
  );
  assert.equal(output.includes('buyer@example.com'), false);
});

test('feedback report fails closed when the sensitive report is not TSV', () => {
  assert.throws(
    () => sanitizeReportText('GET_SELLER_FEEDBACK_DATA', '<xml>buyer@example.com</xml>'),
    (error) => error?.subtype === 'report.sensitive_format_unrecognized',
  );
});

test('non-sensitive report text is unchanged', () => {
  const input = 'sku\tquantity\nSKU-1\t3';
  assert.equal(sanitizeReportText('GET_MERCHANT_LISTINGS_DATA', input), input);
});

// ───────────────────────────────── 通用 PII 兜底(不依赖报告类型登记)

test('配送报告的买家姓名/地址/电话/邮箱列被删除,运营列保留', () => {
  const input = [
    'amazon-order-id\tsku\tquantity-shipped\tbuyer-email\tbuyer-name\trecipient-name\tship-address-1\tship-address-2\tship-phone-number\tship-city\tship-postal-code',
    '111-1111111-1111111\tSKU-1\t2\tbuyer@example.com\tJane Doe\tJane Doe\t123 Main St\tApt 4\t555-0100\tSeattle\t98101',
  ].join('\r\n');

  const output = sanitizeReportText('GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', input);
  for (const leaked of ['buyer@example.com', 'Jane Doe', '123 Main St', 'Apt 4', '555-0100']) {
    assert.equal(output.includes(leaked), false, `PII 泄漏:${leaked}`);
  }
  // 运营需要的列保留:订单号、SKU、数量、城市、邮编
  for (const kept of ['111-1111111-1111111', 'SKU-1', 'Seattle', '98101']) {
    assert.equal(output.includes(kept), true, `运营列被误删:${kept}`);
  }
});

test('未登记的报告类型只要是 TSV,命中通用黑名单的列同样被删', () => {
  const input = ['order-id\tbuyer-email\tsku', '111\tsomeone@example.com\tSKU-9'].join('\n');
  const output = sanitizeReportText('SOME_FUTURE_REPORT_TYPE', input);
  assert.equal(output.includes('someone@example.com'), false, '未登记类型的 PII 列漏删');
  assert.equal(output.includes('SKU-9'), true);
});

test('XML 订单报告(整报告都是收件信息)失败关闭,不输出原文', () => {
  assert.throws(
    () =>
      sanitizeReportText(
        'GET_ORDER_REPORT_DATA_SHIPPING',
        '<?xml version="1.0"?><Address><Name>Jane Doe</Name></Address>',
      ),
    (error) => error?.subtype === 'report.sensitive_format_unrecognized',
  );
});

test('报告类型未知时非 TSV 内容原样返回(无从判断,不误伤)', () => {
  const input = '{"totals": 3}';
  assert.equal(sanitizeReportText(undefined, input), input);
});
