import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeListingIssues } from '../dist/shortcuts/listing/issues.js';

const items = [
  // 健康:有 status BUYABLE+DISCOVERABLE、无 issue → 跳过
  {
    sku: 'OK-1',
    summaries: [{ asin: 'B0OK000001', itemName: 'Good', status: ['BUYABLE', 'DISCOVERABLE'] }],
    issues: [],
  },
  // 有 ERROR issue
  {
    sku: 'ERR-1',
    summaries: [{ asin: 'B0ERR00001', itemName: 'Bad', status: ['BUYABLE', 'DISCOVERABLE'] }],
    issues: [
      { code: '90000', severity: 'ERROR', message: 'missing attr', attributeNames: ['brand'] },
      { code: '80000', severity: 'WARNING', message: 'meh' },
    ],
  },
  // 被压制:不可购买、搜不到,无 issue
  {
    sku: 'SUP-1',
    summaries: [{ asin: 'B0SUP00001', itemName: 'Suppressed', status: [] }],
    issues: [],
  },
  // 只有 WARNING
  {
    sku: 'WARN-1',
    summaries: [{ asin: 'B0WRN00001', itemName: 'Warn', status: ['BUYABLE', 'DISCOVERABLE'] }],
    issues: [{ code: '70000', severity: 'WARNING', message: 'w' }],
  },
];

test('默认 ERROR:只留达到 ERROR 门槛或状态被压制的', () => {
  const { rows, counts } = summarizeListingIssues(items, 'ERROR');
  const skus = rows.map((r) => r.sku).sort();
  // ERR-1(有ERROR) + SUP-1(被压制);OK-1 跳过;WARN-1 只有 WARNING 不计入
  assert.deepEqual(skus, ['ERR-1', 'SUP-1']);
  assert.equal(counts.problems, 2);
  assert.equal(counts.suppressed, 1); // SUP-1 不可购买
  assert.equal(counts.searchHidden, 1); // SUP-1 搜不到
});

test('ERR-1 压缩字段正确,只保留达门槛的 issue', () => {
  const { rows } = summarizeListingIssues(items, 'ERROR');
  const err = rows.find((r) => r.sku === 'ERR-1');
  assert.equal(err.asin, 'B0ERR00001');
  assert.equal(err.buyable, true);
  assert.equal(err.discoverable, true);
  assert.equal(err.issueCount, 1); // WARNING 被门槛过滤掉
  assert.deepEqual(err.issues[0], { code: '90000', severity: 'ERROR', message: 'missing attr', attributeNames: ['brand'] });
});

test('WARNING 门槛:纳入 WARNING,WARN-1 出现', () => {
  const { rows, counts } = summarizeListingIssues(items, 'WARNING');
  const skus = rows.map((r) => r.sku).sort();
  assert.deepEqual(skus, ['ERR-1', 'SUP-1', 'WARN-1']);
  assert.equal(counts.withWarnings, 2); // ERR-1 和 WARN-1 都含 WARNING
});

test('SUP-1 被压制:buyable/discoverable=false 且始终计为问题', () => {
  const { rows } = summarizeListingIssues(items, 'ERROR');
  const sup = rows.find((r) => r.sku === 'SUP-1');
  assert.equal(sup.buyable, false);
  assert.equal(sup.discoverable, false);
  assert.equal(sup.issueCount, 0);
});

test('无 status 字段:buyable/discoverable=null,不误判为压制', () => {
  const { rows } = summarizeListingIssues(
    [{ sku: 'NS-1', summaries: [{ asin: 'B0NS000001' }], issues: [{ severity: 'ERROR', message: 'x' }] }],
    'ERROR',
  );
  assert.equal(rows[0].buyable, null);
  assert.equal(rows[0].discoverable, null);
});
