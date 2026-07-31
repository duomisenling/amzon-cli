import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkuList, readDoneSkus, summarizeReasons } from '../dist/shortcuts/listing/batch.js';

test('parseSkuList 按行/逗号去重保序,SKU 大小写敏感', () => {
  assert.deepEqual(
    parseSkuList('SKU-A\nSKU-B, SKU-A\nsku-a\n  SKU-C  '),
    ['SKU-A', 'SKU-B', 'sku-a', 'SKU-C'],
  );
});

test('readDoneSkus 从 jsonl 里提取已完成 SKU(断点续跑)', () => {
  const jsonl =
    '{"sku":"SKU-A","item":{}}\n' +
    '{"sku":"SKU-B","item":{}}\n' +
    'BROKEN HALF LINE\n' + // 容错:坏行忽略
    '{"sku":"SKU-C","item":{}}\n';
  const done = readDoneSkus(jsonl);
  assert.equal(done.size, 3);
  assert.ok(done.has('SKU-A') && done.has('SKU-B') && done.has('SKU-C'));
});

test('readDoneSkus 空输入返回空集合', () => {
  assert.equal(readDoneSkus('').size, 0);
});

test('summarizeReasons 统计失败原因分布', () => {
  const failures = [
    { subtype: 'sp_api.not_found' },
    { subtype: 'sp_api.not_found' },
    { subtype: 'sp_api.throttled' },
    {},
  ];
  assert.deepEqual(summarizeReasons(failures), {
    'sp_api.not_found': 2,
    'sp_api.throttled': 1,
    unknown: 1,
  });
});
