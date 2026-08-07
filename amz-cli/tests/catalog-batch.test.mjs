import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAsinList, chunk, buildBatchRecords, isValidAsinFormat, CATALOG_BATCH_SIZE } from '../dist/shortcuts/catalog/batch.js';

test('isValidAsinFormat 只认 10 位字母数字', () => {
  assert.equal(isValidAsinFormat('B0ABCDE123'), true);
  assert.equal(isValidAsinFormat('B0FAKE00000'), false); // 11 位
  assert.equal(isValidAsinFormat('B0ZZ'), false);
  assert.equal(isValidAsinFormat('b0abcde123'), true); // 大小写不敏感
});

test('parseAsinList 支持换行/逗号/空格混合,去重保序', () => {
  assert.deepEqual(
    parseAsinList('B0AAAAAAAA\nB0BBBBBBBB, B0AAAAAAAA  B0CCCCCCCC\n'),
    ['B0AAAAAAAA', 'B0BBBBBBBB', 'B0CCCCCCCC'],
  );
});

test('parseAsinList 入口统一大写:小写输入归一,大小写重复只留一个', () => {
  assert.deepEqual(
    parseAsinList('b0aaaaaaaa\nB0AAAAAAAA, b0bbbbbbbb'),
    ['B0AAAAAAAA', 'B0BBBBBBBB'],
  );
});

test('parseAsinList 空输入返回空数组', () => {
  assert.deepEqual(parseAsinList('   \n  '), []);
});

test('chunk 按 20 分片', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  const shards = chunk(items, CATALOG_BATCH_SIZE);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map((s) => s.length), [20, 20, 5]);
});

test('buildBatchRecords 查到的 found:true+摊平,查不到的 found:false,且按请求顺序', () => {
  const requested = ['B0AAAAAAAA', 'B0MISSING0', 'B0BBBBBBBB'];
  const found = [
    { asin: 'B0BBBBBBBB', summaries: [{ itemName: 'B item' }], images: [{ x: 1 }] },
    { asin: 'B0AAAAAAAA', summaries: [{ itemName: 'A item' }] },
  ];
  const out = buildBatchRecords(requested, found, ['images', 'summaries']);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { found: true, asin: 'B0AAAAAAAA', itemName: 'A item' });
  assert.deepEqual(out[1], { asin: 'B0MISSING0', found: false }); // 查不到
  assert.equal(out[2].found, true);
  assert.equal(out[2].asin, 'B0BBBBBBBB');
  assert.deepEqual(out[2].images, [{ x: 1 }]); // 额外数据集原样保留
});

test('buildBatchRecords 大小写不敏感匹配:小写请求也能命中 API 返回的大写 asin', () => {
  const out = buildBatchRecords(
    ['b0aaaaaaaa'],
    [{ asin: 'B0AAAAAAAA', summaries: [{ itemName: 'A item' }] }],
    ['summaries'],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].found, true); // 修复前会被误标 found:false 静默丢弃
  assert.equal(out[0].itemName, 'A item');
});
