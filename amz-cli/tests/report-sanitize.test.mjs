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
