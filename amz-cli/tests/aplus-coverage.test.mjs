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

// ───────────────────────────────── aplus get(内容本体)

test('summarizeAplusModules 递归收集模块文案与图片替代文本', async () => {
  const { summarizeAplusModules } = await import('../dist/shortcuts/aplus/content.js');
  const modules = [
    {
      contentModuleType: 'STANDARD_IMAGE_TEXT_OVERLAY',
      standardImageTextOverlay: {
        block: {
          image: {
            altText: '产品使用场景图',
            uploadDestinationId: 'internal-ref-123',
            imageCropSpecification: {},
          },
          headline: { value: '大标题文案', decoratorSet: [] },
          body: { textList: [{ value: '正文第一段', decoratorSet: [] }] },
        },
      },
    },
    { contentModuleType: 'STANDARD_TEXT', standardText: { headline: { value: '纯文本标题' } } },
  ];
  const summaries = summarizeAplusModules(modules);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].type, 'STANDARD_IMAGE_TEXT_OVERLAY');
  assert.deepEqual(summaries[0].texts, ['大标题文案', '正文第一段']);
  assert.deepEqual(summaries[0].imageAltTexts, ['产品使用场景图']);
  // 内部引用 ID 不该混进文案
  assert.equal(JSON.stringify(summaries[0].texts).includes('internal-ref-123'), false);
  assert.deepEqual(summaries[1], { type: 'STANDARD_TEXT', texts: ['纯文本标题'], imageAltTexts: [] });
});

test('aplus get 返回内容摘要,默认不带原始结构,--raw 才带', async () => {
  const { aplusGet } = await import('../dist/shortcuts/aplus/content.js');
  const contentRecord = {
    contentReferenceKey: 'K1',
    contentMetadata: { name: '文档名', status: 'APPROVED' },
    contentDocument: {
      name: '文档名',
      contentType: 'EBC',
      locale: 'de-DE',
      contentModuleList: [
        { contentModuleType: 'STANDARD_TEXT', standardText: { headline: { value: '标题' } } },
      ],
    },
  };
  const makeCtx = (flags) => ({
    flags: { marketplace: 'DE', contentKey: 'K1', ...flags },
    progress() {},
    client: {
      async get(path, query) {
        assert.match(path, /contentDocuments\/K1$/);
        assert.equal(query.includedDataSet, 'CONTENTS,METADATA');
        return { contentRecord };
      },
    },
  });

  const summary = await aplusGet.execute(makeCtx({}));
  assert.equal(summary.contentReferenceKey, 'K1');
  assert.equal(summary.status, 'APPROVED');
  assert.equal(summary.moduleCount, 1);
  assert.deepEqual(summary.modules[0].texts, ['标题']);
  assert.equal('contentDocument' in summary, false, '默认不该带原始结构');

  const raw = await aplusGet.execute(makeCtx({ raw: true }));
  assert.equal(raw.contentDocument.contentType, 'EBC');
});
