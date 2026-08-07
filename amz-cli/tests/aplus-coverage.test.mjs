import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAplusCoverage, DEFAULT_APLUS_ACCEPTED_STATUS, aplusDocuments, aplusAsins } from '../dist/shortcuts/aplus/content.js';

const docs = [
  { contentReferenceKey: 'K1', status: 'APPROVED' },
  { contentReferenceKey: 'K2', status: 'DRAFT' }, // 未发布,不算
  { contentReferenceKey: 'K3', status: 'SUBMITTED' }, // 未批准,不算
  { contentReferenceKey: 'K4', status: 'APPROVED' },
];
const asinsByKey = {
  K1: ['B0AAAAAAAA', 'B0BBBBBBBB'],
  K2: ['B0CCCCCCCC'],
  K3: ['B0DDDDDDDD'],
  K4: ['B0EEEEEEEE'],
};

test('默认只收 APPROVED 状态,展平成每 ASIN 一条', () => {
  const rows = buildAplusCoverage(docs, asinsByKey, DEFAULT_APLUS_ACCEPTED_STATUS);
  assert.deepEqual(rows, [
    { asin: 'B0AAAAAAAA', contentReferenceKey: 'K1', status: 'APPROVED' },
    { asin: 'B0BBBBBBBB', contentReferenceKey: 'K1', status: 'APPROVED' },
    { asin: 'B0EEEEEEEE', contentReferenceKey: 'K4', status: 'APPROVED' },
  ]);
});

test('DEFAULT_APLUS_ACCEPTED_STATUS 是 APPROVED(官方无 PUBLISHED)', () => {
  assert.deepEqual(DEFAULT_APLUS_ACCEPTED_STATUS, ['APPROVED']);
});

test('状态匹配大小写不敏感', () => {
  const rows = buildAplusCoverage([{ contentReferenceKey: 'K1', status: 'APPROVED' }], { K1: ['B0AAAAAAAA'] }, ['approved']);
  assert.equal(rows.length, 1);
});

test('可放宽可接受状态(如把 SUBMITTED 也算上)', () => {
  const rows = buildAplusCoverage(docs, asinsByKey, ['APPROVED', 'SUBMITTED']);
  assert.deepEqual(rows.map((r) => r.contentReferenceKey), ['K1', 'K1', 'K3', 'K4']);
});

test('跳过无 key 或无状态的文档', () => {
  const rows = buildAplusCoverage(
    [{ status: 'APPROVED' }, { contentReferenceKey: 'K9' }],
    { K9: ['B0ZZZZZZZZ'] },
    ['APPROVED'],
  );
  assert.deepEqual(rows, []);
});

test('文档列表翻页超过 100 页熔断,抛类型化上游错误', async () => {
  const ctx = {
    flags: { marketplace: 'UK' },
    progress() {},
    client: {
      // 永远返回 nextPageToken,模拟上游分页异常
      async get() {
        return { contentMetadataRecords: [], nextPageToken: 'ALWAYS-MORE' };
      },
    },
  };
  await assert.rejects(
    () => aplusDocuments.execute(ctx),
    (e) => e?.subtype === 'aplus.pagination_overflow' && e?.type === 'upstream_error',
  );
});

test('单文档 ASIN 列表翻页超过 100 页同样熔断', async () => {
  const ctx = {
    flags: { marketplace: 'UK', contentKey: 'K1' },
    progress() {},
    client: {
      async get() {
        return { asinMetadataSet: [{ asin: 'B0AAAAAAAA' }], nextPageToken: 'ALWAYS-MORE' };
      },
    },
  };
  await assert.rejects(
    () => aplusAsins.execute(ctx),
    (e) => e?.subtype === 'aplus.pagination_overflow' && e?.type === 'upstream_error',
  );
});
