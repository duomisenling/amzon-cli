// listing batch —— 批量拉自己 listing 的 attributes(逐 SKU),支持并发 + 断点续跑 + 失败隔离
//
// API: Listings Items 2021-08-01 getListingsItem(与 listing sku 同一接口,逐个查)
//   GET /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=X&includedData=attributes,...
//
// 关键(任务书要求):
//   - 只能逐个查,1200 次是常态 → --concurrency 并发(实际节奏仍受客户端全局限速器约束)。
//   - 断点续跑:结果以 jsonl 增量写入 --out;重跑时读取 --out 里已完成的 SKU 跳过,不从 0 开始。
//   - 失败隔离:单个 SKU 失败不中断整批;失败写入 <out>.failures.jsonl,并在 stderr 汇总。
//   - 透传整个 attributes 对象,不在 CLI 里筛字段(筛是下游的事)。
// 角色:Product Listing

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag, validateNumberFlag } from '../common.js';
import { resolveSellerId, validateListingsIncludedData } from './mine.js';

/** 解析 SKU 列表:按行/逗号分隔,去重保序(SKU 大小写敏感,不做大小写归一)。 */
export function parseSkuList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    for (const token of line.split(',')) {
      const sku = token.trim();
      if (sku && !seen.has(sku)) {
        seen.add(sku);
        out.push(sku);
      }
    }
  }
  return out;
}

/** 从已有 jsonl 输出里读出"已完成的 SKU 集合"(每行一个对象,取 .sku),用于断点续跑。 */
export function readDoneSkus(jsonlText: string): Set<string> {
  const done = new Set<string>();
  for (const line of jsonlText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as { sku?: unknown };
      if (typeof obj.sku === 'string' && obj.sku) done.add(obj.sku);
    } catch {
      // 坏行忽略(容错:半截写入的行不影响续跑)
    }
  }
  return done;
}

/** 失败原因分布统计(便于 stderr 汇总)。 */
export function summarizeReasons(failures: Array<{ subtype?: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const key = f.subtype ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** 简单并发池:N 个 worker 从队列取任务,全部完成后返回。 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        await worker(items[i]!, i);
      }
    }),
  );
}

export const listingBatch: ToolDefinition = {
  service: 'listing',
  command: 'batch',
  description:
    '批量拉自己 listing 的 attributes(逐 SKU;并发 + 断点续跑 + 失败隔离);结果增量写入 --out(jsonl)',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 UK / DE / US(必填)', required: true },
    { name: 'sku-file', desc: 'SKU 列表文件路径(每行一个;与 --skus 二选一)' },
    { name: 'skus', desc: 'SKU 列表,逗号分隔(与 --sku-file 二选一)' },
    { name: 'out', desc: '结果 jsonl 输出文件(必填;每行一个 SKU 结果,断点续跑依赖它)', required: true },
    { name: 'seller-id', desc: '卖家编号(本地可省略读 SELLER_ID;Broker 模式仅核对)' },
    {
      name: 'include',
      desc: '返回的数据集,逗号分隔,默认 attributes。可加 summaries/issues/relationships/productTypes 等',
    },
    { name: 'concurrency', desc: '并发数,默认 4(1-10;实际节奏仍受客户端限速)' },
  ],
  validate: (flags) => {
    if (!strFlag(flags, 'skuFile') && !strFlag(flags, 'skus')) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'missing_sku_input',
        param: '--sku-file',
        hintAgent: 'fix_param',
        hintHuman: '请提供 --sku-file(SKU 文件)或 --skus(逗号分隔)其中之一。',
        message: 'either --sku-file or --skus is required',
      });
    }
    validateNumberFlag(flags, 'concurrency', '--concurrency', { min: 1, max: 10, integer: true });
    validateListingsIncludedData(flags);
  },
  execute: async (ctx: ToolContext) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const sellerId = await resolveSellerId(ctx.flags, mkt.region, ctx.client);
    const include = strFlag(ctx.flags, 'include') ?? 'attributes';
    const concurrency = Number(strFlag(ctx.flags, 'concurrency') ?? 4);
    const outPath = strFlag(ctx.flags, 'out')!;
    const failPath = `${outPath}.failures.jsonl`;

    // 读入 SKU 列表
    const file = strFlag(ctx.flags, 'skuFile');
    let raw: string;
    if (file) {
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'sku_file_unreadable',
          param: '--sku-file',
          hintAgent: 'fix_param',
          hintHuman: `读不到 SKU 文件:${file}。请检查路径。`,
          message: `cannot read --sku-file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      raw = strFlag(ctx.flags, 'skus') ?? '';
    }
    const allSkus = parseSkuList(raw);
    if (allSkus.length === 0) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'empty_sku_list',
        param: '--sku-file',
        hintAgent: 'fix_param',
        hintHuman: 'SKU 列表为空,请检查文件内容或 --skus。',
        message: 'parsed SKU list is empty',
      });
    }

    // 断点续跑:已在 --out 里的 SKU 跳过
    const done = existsSync(outPath) ? readDoneSkus(readFileSync(outPath, 'utf8')) : new Set<string>();
    const pending = allSkus.filter((sku) => !done.has(sku));
    ctx.progress(
      `· 共 ${allSkus.length} 个 SKU;已完成 ${done.size} 个(断点续跑跳过),本次拉 ${pending.length} 个,并发 ${concurrency}...`,
    );

    const failures: Array<{ sku: string; subtype?: string; message: string }> = [];
    let succeeded = 0;
    let processed = 0;

    await runPool(pending, concurrency, async (sku) => {
      try {
        const item = (await ctx.client.get(
          `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
          { marketplaceIds: mkt.id, includedData: include },
          mkt.region,
        )) as Record<string, unknown>;
        // 成功:增量写入 jsonl(断点续跑靠这一行落盘)
        appendFileSync(outPath, JSON.stringify({ sku, marketplace: mkt.country, item }) + '\n', 'utf8');
        succeeded += 1;
      } catch (err) {
        const subtype = err instanceof AmzError ? err.subtype : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ sku, subtype, message });
        // 失败:写失败文件,不中断整批
        appendFileSync(failPath, JSON.stringify({ sku, subtype, message }) + '\n', 'utf8');
      }
      processed += 1;
      if (processed % 50 === 0) {
        ctx.progress(`· 进度 ${processed}/${pending.length}(成功 ${succeeded},失败 ${failures.length})...`);
      }
    });

    const reasonCounts = summarizeReasons(failures);
    // 汇总也打到 stderr(任务书要求),结构化结果仍走 stdout 信封
    ctx.progress(
      `· 完成:本次成功 ${succeeded},失败 ${failures.length};` +
        `失败原因分布 ${JSON.stringify(reasonCounts)}`,
    );

    return {
      marketplace: mkt.country,
      totalSkus: allSkus.length,
      alreadyDone: done.size,
      attempted: pending.length,
      succeeded,
      failed: failures.length,
      reasonCounts,
      outFile: outPath,
      ...(failures.length ? { failuresFile: failPath } : {}),
    };
  },
};

// 保证空批也创建 out 文件(便于下游无条件读取);仅在需要时使用。
export function ensureOutFile(outPath: string): void {
  if (!existsSync(outPath)) writeFileSync(outPath, '', 'utf8');
}
