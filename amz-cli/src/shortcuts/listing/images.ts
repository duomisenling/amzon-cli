// listing images —— 按 ASIN 拿商品图片(URL 列表),可选下载保存到本地文件夹
//
// API: Catalog Items API 2022-04-01 searchCatalogItems(identifiers 批量,includedData=images)
//   一次调用最多 20 个 ASIN(与 catalog batch 同一批量端点、同一分片上限),
//   images 按站点分组,每张含 variant(MAIN=主图,PT01..=副图,SWCH=色板图等)、
//   link(公开 CDN 地址)、height/width。同一 variant 有多个尺寸,下载只取最大的。
// 角色:Product Listing
//
// 下载走 fetchDocumentBuffer('sp' 通道):图片 CDN(m.media-amazon.com)也是亚马逊侧
// 主机,与其他请求保持一致的出口。配了代理的账号,代理目的地白名单需包含该域名
// (下载全挂而目录查询正常时,结果里会给出这条提示)。

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AmzError } from '../../internal/errs/errors.js';
import { egressStatus } from '../../internal/net/egress.js';
import type { ToolDefinition } from '../../tools/types.js';
import { fetchDocumentBuffer, resolveMarketplace, strFlag } from '../common.js';
import { isValidAsinFormat, parseAsinList } from '../catalog/batch.js';

export interface CatalogImage {
  variant?: string;
  link?: string;
  height?: number;
  width?: number;
}

const MAX_ASINS = 20; // 批量目录端点单次上限,与 catalog batch 的分片大小一致

/** 同时下载的图片数。CDN 下载不占 SP-API 限速额度,适度并发缩短整批耗时。 */
const DOWNLOAD_CONCURRENCY = 4;

/**
 * 每个 variant 只留最大的一张(同 variant 多尺寸是缩略图,内容相同)。
 * 缺宽高的按"疑似原图"处理(排最大):目录接口的缩略图都带尺寸,
 * 不带尺寸的反而可能是原图,不能让它输给 75x75 的缩略图。
 */
export function pickLargestPerVariant(images: CatalogImage[]): CatalogImage[] {
  const area = (img: CatalogImage): number =>
    img.height && img.width ? img.height * img.width : Number.MAX_SAFE_INTEGER;
  const best = new Map<string, CatalogImage>();
  for (const img of images) {
    if (!img.link) continue;
    const variant = img.variant ?? 'UNKNOWN';
    const current = best.get(variant);
    if (!current || area(img) > area(current)) best.set(variant, img);
  }
  return [...best.values()];
}

/**
 * 下载文件名:ASIN_变体.扩展名。ASIN 与 variant 都只保留字母数字与 _-
 * (variant 来自 API 响应,不能未消毒就拼进文件路径);
 * 扩展名取自 URL 路径且只认常规图片后缀,取不到用 .jpg。
 */
export function imageFileName(asin: string, variant: string | undefined, link: string): string {
  const safe = (token: string): string => token.replace(/[^A-Za-z0-9_-]/g, '');
  let ext = '.jpg';
  try {
    const pathname = new URL(link).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot >= 0 && /^\.(?:jpe?g|png|gif|webp)$/i.test(pathname.slice(dot))) {
      ext = pathname.slice(dot).toLowerCase();
    }
  } catch {
    // URL 解析失败就用默认扩展名
  }
  const variantToken = safe(variant ?? 'UNKNOWN') || 'UNKNOWN';
  return `${safe(asin)}_${variantToken}${ext}`;
}

/** 有界并发执行:最多 limit 个任务同时进行,结果按输入顺序返回。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

interface DownloadOutcome {
  asin: string;
  variant?: string;
  file?: string;
  error?: string;
}

export const listingImages: ToolDefinition = {
  service: 'listing',
  command: 'images',
  description:
    '按 ASIN 拿商品图片:列出主图/副图各变体的 URL 与尺寸;给 --out-dir 则把每个变体的最大尺寸图下载保存到该文件夹',
  mutation: 'none',
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / DE / UK(必填)', required: true },
    { name: 'asins', desc: `商品 ASIN,逗号分隔,去重后最多 ${MAX_ASINS} 个(必填)`, required: true },
    { name: 'out-dir', desc: '下载图片到该文件夹(可选;不给则只返回 URL 列表)' },
  ],
  validate: (flags) => {
    // 与 execute 同一份解析(parseAsinList:大写归一 + 去重),数量校验才和实际请求一致
    const asins = parseAsinList(strFlag(flags, 'asins') ?? '');
    if (asins.length === 0 || asins.length > MAX_ASINS) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'listing.images_asins_invalid',
        param: '--asins',
        hintAgent: 'fix_param',
        hintHuman: `--asins 需要 1~${MAX_ASINS} 个 ASIN(去重后),逗号分隔。`,
        message: `--asins requires 1-${MAX_ASINS} unique ASINs, got ${asins.length}`,
      });
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const asins = parseAsinList(strFlag(ctx.flags, 'asins') ?? '');
    const outDir = strFlag(ctx.flags, 'outDir');
    if (outDir) mkdirSync(outDir, { recursive: true });

    // 格式非法的先挡在客户端记 found:false,不发给 API(与 catalog batch 同语义);
    // 同时这也保证了进入文件名的 ASIN 必然是 10 位字母数字。
    const valid = asins.filter((a) => isValidAsinFormat(a));
    const invalid = asins.filter((a) => !isValidAsinFormat(a));

    // 一次批量调用拿全:不逐个 getCatalogItem(那样 20 个 ASIN 要串行 20 次限速请求)。
    // 认证/限流等批级错误在这里直接抛出类型化错误,绝不吞成 found:false。
    const byAsin = new Map<string, CatalogImage[]>();
    if (valid.length > 0) {
      ctx.progress(`· 正在批量查询 ${valid.length} 个 ASIN 的图片...`);
      const resp = (await ctx.client.get(
        '/catalog/2022-04-01/items',
        {
          marketplaceIds: mkt.id,
          identifiers: valid.join(','),
          identifiersType: 'ASIN',
          includedData: 'images',
        },
        mkt.region,
      )) as { items?: Array<{ asin?: string; images?: Array<{ images?: CatalogImage[] }> }> };
      for (const item of resp.items ?? []) {
        if (!item.asin) continue;
        byAsin.set(item.asin.toUpperCase(), (item.images ?? []).flatMap((g) => g.images ?? []));
      }
    }

    // 下载任务先统一收集,再有界并发执行;单张失败只记录该张,不中断其他下载
    const downloadTasks: Array<{ asin: string; img: CatalogImage }> = [];
    const records = asins.map((asin) => {
      if (invalid.includes(asin)) {
        return { asin, found: false, error: 'ASIN 格式非法(应为 10 位字母数字),未发请求' };
      }
      const all = byAsin.get(asin);
      if (all === undefined) return { asin, found: false }; // 目录里查不到该 ASIN
      const largest = pickLargestPerVariant(all);
      if (outDir) for (const img of largest) downloadTasks.push({ asin, img });
      // found:true + variantCount 0 表示"ASIN 存在但暂无图片",与"查不到"可区分
      return { asin, found: true, variantCount: largest.length, images: largest };
    });

    let outcomes: DownloadOutcome[] = [];
    if (outDir && downloadTasks.length > 0) {
      ctx.progress(`· 正在下载 ${downloadTasks.length} 张图片(并发 ${DOWNLOAD_CONCURRENCY})...`);
      outcomes = await mapWithConcurrency(downloadTasks, DOWNLOAD_CONCURRENCY, async ({ asin, img }) => {
        try {
          const buf = await fetchDocumentBuffer(img.link!, {
            what: `${asin} 的 ${img.variant ?? '图片'}`,
            subtype: 'listing.image_download_failed',
            channel: 'sp',
          });
          const file = join(outDir, imageFileName(asin, img.variant, img.link!));
          await writeFile(file, buf);
          return { asin, variant: img.variant, file };
        } catch (err) {
          return {
            asin,
            variant: img.variant,
            error: err instanceof AmzError ? err.subtype : (err instanceof Error ? err.message : String(err)),
          };
        }
      });
    }

    const withDownloads = records.map((r) => {
      if (!outDir || !r.found) return r;
      const mine = outcomes.filter((o) => o.asin === r.asin);
      const saved = mine.filter((o) => o.file).map((o) => o.file!);
      const failed = mine.filter((o) => o.error).map((o) => ({ variant: o.variant, error: o.error }));
      return { ...r, saved, ...(failed.length > 0 ? { downloadFailed: failed } : {}) };
    });

    const savedTotal = outcomes.filter((o) => o.file).length;
    const failedTotal = outcomes.filter((o) => o.error).length;
    const hints: string[] = [];
    if (failedTotal > 0) {
      hints.push('部分图片下载失败(见各 ASIN 的 downloadFailed);重跑本命令只需重试失败的那几张。');
      if (failedTotal === downloadTasks.length && egressStatus().sp.configured) {
        hints.push(
          '所有下载都失败而目录查询正常:该账号走代理,代理的目的地白名单可能没放行图片 CDN 域名' +
            '(m.media-amazon.com),请管理员核对。',
        );
      }
    }

    return {
      marketplace: mkt.country,
      count: withDownloads.length,
      ...(outDir ? { outDir, savedTotal, failedTotal } : {}),
      items: withDownloads,
      ...(hints.length > 0 ? { hints } : {}),
      note: outDir
        ? '每个变体只下载最大尺寸的一张;文件名为 ASIN_变体.扩展名(MAIN=主图,PT01 起为副图)。'
        : 'images 为各变体的最大尺寸 URL(公开 CDN 地址);加 --out-dir 可直接下载保存。',
    };
  },
};

