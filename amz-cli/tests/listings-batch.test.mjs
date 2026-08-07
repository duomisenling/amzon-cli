import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkuList,
  readDoneSkus,
  summarizeReasons,
  normalizeIncludeSet,
  readJournalMeta,
  listingBatch,
} from '../dist/shortcuts/listing/batch.js';

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

test('normalizeIncludeSet 去空白/去重/排序:顺序不同不算 include 集合变化', () => {
  assert.equal(normalizeIncludeSet(' summaries, attributes ,attributes'), 'attributes,summaries');
  assert.equal(normalizeIncludeSet('attributes,summaries'), normalizeIncludeSet('summaries , attributes'));
});

test('readJournalMeta 读出首个 meta 行;老 journal 无 meta 返回 undefined', () => {
  const jsonl =
    '{"journalMeta":{"include":"attributes"}}\n' +
    '{"sku":"SKU-A","item":{}}\n';
  assert.deepEqual(readJournalMeta(jsonl), { include: 'attributes' });
  assert.equal(readJournalMeta('{"sku":"SKU-A","item":{}}\n'), undefined);
  assert.equal(readJournalMeta(''), undefined);
});

test('readDoneSkus 忽略 journalMeta 行,不把它算成已完成 SKU', () => {
  const jsonl = '{"journalMeta":{"include":"attributes"}}\n{"sku":"SKU-A","item":{}}\n';
  const done = readDoneSkus(jsonl);
  assert.equal(done.size, 1);
  assert.ok(done.has('SKU-A'));
});

test('listing batch:新 journal 首行写 meta;续跑时 --include 变化报错,一致则跳过已完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-listing-batch-'));
  const outPath = join(dir, 'out.jsonl');
  try {
    const makeCtx = (include) => ({
      flags: {
        marketplace: 'US',
        skus: 'SKU-A,SKU-B',
        out: outPath,
        sellerId: 'SELLER',
        ...(include ? { include } : {}),
      },
      progress() {},
      client: {
        async get() {
          return { attributes: {} };
        },
      },
    });

    // 首跑(默认 include=attributes):meta 行落在文件头
    const first = await listingBatch.execute(makeCtx());
    assert.equal(first.succeeded, 2);
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    assert.deepEqual(JSON.parse(lines[0]), { journalMeta: { include: 'attributes' } });

    // include 集合变化 → 报错要求换 --out 或删除重跑
    await assert.rejects(
      () => listingBatch.execute(makeCtx('attributes,summaries')),
      (e) => e?.subtype === 'listing.batch_include_changed',
    );

    // include 一致 → 正常续跑,已完成的全部跳过
    const resumed = await listingBatch.execute(makeCtx('attributes'));
    assert.equal(resumed.alreadyDone, 2);
    assert.equal(resumed.attempted, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
