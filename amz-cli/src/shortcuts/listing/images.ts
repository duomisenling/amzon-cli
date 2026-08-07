// listing images —— 按 ASIN 拿商品图片(URL 列表),可选下载保存到本地文件夹
//
// API: Catalog Items API 2022-04-01 getCatalogItem(includedData=images)
//   images 返回按站点分组的图片数组,每张含 variant(MAIN=主图,PT01..=副图,
//   SWCH=色板图等)、link(公开 CDN 地址)、height/width。
//   同一 variant 会返回多个尺寸 —— 下载时只取每个 variant 的最大尺寸,避免重复。
// 角色:Product Listing
//
// 下载走 amazonFetch('sp' 通道):图片 CDN(m.media-amazon.com)也是亚马逊侧主机,
// 与其他请求保持一致的出口。配了代理的账号,代理目的地白名单需包含该域名。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AmzError } from '../../internal/errs/errors.js';
import { amazonFetch } from '../../internal/net/egress.js';
import type { ToolDefinition } from '../../tools/types.js';
import { resolveMarketplace, strFlag } from '../common.js';

export interface CatalogImage {
  variant?: string;
  link?: string;
  height?: number;
  width?: number;
}

/** 每个 variant 只留面积最大的一张(同 variant 多尺寸是缩略图,内容相同)。 */
export function pickLargestPerVariant(images: CatalogImage[]): CatalogImage[] {
  const best = new Map<string, CatalogImage>();
  for (const img of images) {
    if (!img.link) continue;
    const variant = img.variant ?? 'UNKNOWN';
    const area = (img.height ?? 0) * (img.width ?? 0);
    const current = best.get(variant);
    const currentArea = current ? (current.height ?? 0) * (current.width ?? 0) : -1;
    if (area > currentArea) best.set(variant, img);
  }
  return [...best.values()];
}

/** 下载文件名:ASIN_变体.扩展名(扩展名取自 URL 路径,取不到用 .jpg)。 */
export function imageFileName(asin: string, variant: string | undefined, link: string): string {
  let ext = '.jpg';
  try {
    const pathname = new URL(link).pathname;
    const dot = pathname.lastIndexOf('.');
    // 扩展名只认常规图片后缀,防止 URL 末段的奇怪内容进文件名
    if (dot >= 0 && /^\.(?:jpe?g|png|gif|webp)$/i.test(pathname.slice(dot))) {
      ext = pathname.slice(dot).toLowerCase();
    }
  } catch {
    // URL 解析失败就用默认扩展名
  }
  return `${asin}_${variant ?? 'UNKNOWN'}${ext}`;
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
    { name: 'asins', desc: '商品 ASIN,逗号分隔,最多 20 个(必填)', required: true },
    { name: 'out-dir', desc: '下载图片到该文件夹(可选;不给则只返回 URL 列表)' },
  ],
  validate: (flags) => {
    const raw = strFlag(flags, 'asins') ?? '';
    const asins = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (asins.length === 0 || asins.length > 20) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'listing.images_asins_invalid',
        param: '--asins',
        hintAgent: 'fix_param',
        hintHuman: '--asins 需要 1~20 个 ASIN,逗号分隔。',
        message: `--asins requires 1-20 ASINs, got ${asins.length}`,
      });
    }
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    // 与 catalog batch 同口径:入口统一大写,防止小写 ASIN 匹配不上 API 返回
    const asins = [...new Set(
      (strFlag(ctx.flags, 'asins') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    )];
    const outDir = strFlag(ctx.flags, 'outDir');
    if (outDir) mkdirSync(outDir, { recursive: true });

    const items: Array<Record<string, unknown>> = [];
    let savedTotal = 0;
    for (const [i, asin] of asins.entries()) {
      ctx.progress(`· 正在查询 ${asin} 的图片(${i + 1}/${asins.length})...`);
      let imagesByMarketplace: Array<{ images?: CatalogImage[] }>;
      try {
        const item = (await ctx.client.get(
          `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
          { marketplaceIds: mkt.id, includedData: 'images' },
          mkt.region,
        )) as { images?: Array<{ images?: CatalogImage[] }> };
        imagesByMarketplace = item.images ?? [];
      } catch (err) {
        // 单个 ASIN 查不到(404 等)不拖垮整批,如实记录
        items.push({
          asin,
          found: false,
          error: err instanceof AmzError ? err.subtype : (err instanceof Error ? err.message : String(err)),
        });
        continue;
      }

      const all = imagesByMarketplace.flatMap((group) => group.images ?? []);
      const largest = pickLargestPerVariant(all);
      const saved: string[] = [];
      if (outDir) {
        for (const img of largest) {
          if (!img.link) continue;
          ctx.progress(`· 正在下载 ${asin} 的 ${img.variant ?? '图片'}...`);
          const resp = await amazonFetch(
            img.link,
            { signal: AbortSignal.timeout(60_000) },
            'sp',
          );
          if (!resp.ok) {
            throw new AmzError({
              type: 'upstream_error',
              subtype: 'listing.image_download_failed',
              hintAgent: 'backoff_and_retry',
              hintHuman: `下载 ${asin} 的图片失败(HTTP ${resp.status}),请稍后重试。`,
              message: `image download failed: HTTP ${resp.status} for ${asin} ${img.variant ?? ''}`,
              status: resp.status,
              retryable: true,
            });
          }
          const file = join(outDir, imageFileName(asin, img.variant, img.link));
          writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
          saved.push(file);
        }
        savedTotal += saved.length;
      }

      items.push({
        asin,
        found: all.length > 0,
        variantCount: largest.length,
        images: largest,
        ...(outDir ? { saved } : {}),
      });
    }

    return {
      marketplace: mkt.country,
      count: items.length,
      ...(outDir ? { outDir, savedTotal } : {}),
      items,
      note: outDir
        ? '每个变体只下载最大尺寸的一张;文件名为 ASIN_变体.扩展名(MAIN=主图,PT01 起为副图)。'
        : 'images 为各变体的全部尺寸 URL(公开 CDN 地址);加 --out-dir 可直接下载保存。',
    };
  },
};
