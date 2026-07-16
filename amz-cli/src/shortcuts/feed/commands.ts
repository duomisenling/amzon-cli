// feed 命令组:submit(不可撤销写)/ status / result
//
// API: Feeds API 2021-06-30(2026-07-13 从官方 OpenAPI 规范核实)
//   POST /feeds/2021-06-30/documents          createFeedDocument(拿预签名上传 URL,5 分钟有效)
//   PUT  <预签名 URL>                          上传 feed 内容
//   POST /feeds/2021-06-30/feeds              createFeed(限速 0.0083/s!)
//   GET  /feeds/2021-06-30/feeds/{feedId}     getFeed(2/s,轮询用)
//   GET  /feeds/2021-06-30/documents/{docId}  拿处理结果文档
//   processingStatus:IN_QUEUE/IN_PROGRESS/DONE/FATAL/CANCELLED
//
// 门槛:Feed 一旦处理完成无法撤回(规格 §7.2)→ mutation=irreversible。
//   --dry-run     只做本地格式检查与预览，不上传任何内容
//   真正执行      CLI 要求交互式终端输入随机确认码(防误操作门禁)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { OPTIONAL_MARKETPLACE_FLAG, fetchDocumentBuffer, optionalRegion, resolveMarketplace, strFlag } from '../common.js';
import type { Region } from '../../internal/client/regions.js';

const FEED_CONTENT_TYPE = 'text/tab-separated-values; charset=UTF-8';

function validateFlatFileFeed(flags: Record<string, unknown>): { content: string; lines: string[] } {
  const feedType = strFlag(flags, 'type') ?? '';
  if (!feedType.startsWith('POST_FLAT_FILE_')) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'unsupported_feed_content_type',
      param: '--type',
      hintAgent: 'fix_param',
      hintHuman:
        '当前 feed submit 只支持 POST_FLAT_FILE_* 类型的 TSV 文件。JSON/XML Feed 尚未实现，不能用 TSV content-type 冒险提交。',
      message: `unsupported feed type for TSV uploader: ${feedType}`,
    });
  }
  const content = readFeedFile(flags);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2 || !lines[0]!.includes('\t')) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_feed_tsv',
      param: '--file',
      hintAgent: 'fix_param',
      hintHuman: 'Feed 文件必须是含制表符表头且至少有一行数据的 TSV 文件。',
      message: 'feed file is not a non-empty TSV with a header and data row',
    });
  }
  return { content, lines };
}

function readFeedFile(flags: Record<string, unknown>): string {
  const path = strFlag(flags, 'file');
  if (!path) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'missing_feed_file',
      param: '--file',
      hintAgent: 'fix_param',
      hintHuman: '请用 --file 指定要提交的 feed 文件路径(TSV 格式)。',
      message: '--file is required',
    });
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'feed_file_unreadable',
      param: '--file',
      hintAgent: 'fix_param',
      hintHuman: `读不到文件 "${path}",请检查路径是否正确。`,
      message: `cannot read feed file: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** 创建 feed 文档并上传内容,返回 feedDocumentId。 */
async function uploadFeedDocument(ctx: ToolContext, content: string, region?: Region): Promise<string> {
  ctx.progress('· 正在创建 feed 文档(获取上传地址)...');
  const doc = (await ctx.client.request('POST', '/feeds/2021-06-30/documents', {
    body: { contentType: FEED_CONTENT_TYPE },
    region,
  })) as { feedDocumentId?: string; url?: string };
  if (!doc.feedDocumentId || !doc.url) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'feed.no_upload_url',
      hintAgent: 'report_to_human',
      hintHuman: '亚马逊没有返回上传地址,请稍后重试。',
      message: `createFeedDocument returned: ${JSON.stringify(doc)}`,
    });
  }

  ctx.progress('· 正在上传 feed 内容...');
  // 预签名 S3 地址:PUT 原始内容,Content-Type 必须与 createFeedDocument 声明一致
  const up = await fetch(doc.url, {
    method: 'PUT',
    headers: { 'Content-Type': FEED_CONTENT_TYPE },
    body: content,
    signal: AbortSignal.timeout(120_000),
  });
  if (!up.ok) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'feed.upload_failed',
      hintAgent: 'backoff_and_retry',
      hintHuman: 'feed 内容上传失败(上传地址 5 分钟内有效),请重新执行。',
      message: `feed upload failed: HTTP ${up.status}`,
      status: up.status,
      retryable: true,
    });
  }
  return doc.feedDocumentId;
}

export const feedSubmit: ToolDefinition = {
  service: 'feed',
  command: 'submit',
  description:
    '提交 TSV Feed 批量修改(库存/GPSR 等)。不可撤销:--dry-run 仅做本地格式检查和预览;真正执行要求终端确认码',
  mutation: 'irreversible',
  isAsync: true,
  roles: ['Product Listing'],
  flags: [
    { name: 'marketplace', desc: '市场,国家码如 US / CA / MX(必填)', required: true },
    { name: 'type', desc: 'feed 类型,如 POST_FLAT_FILE_INVLOADER_DATA(必填)', required: true },
    { name: 'file', desc: '要提交的 feed 文件路径,TSV 格式(必填)', required: true },
  ],
  validate: (flags) => {
    validateFlatFileFeed(flags);
  },
  describe: (flags) =>
    `向 ${strFlag(flags, 'marketplace')?.toUpperCase()} 站点提交 Feed 批量修改:` +
    `类型 ${strFlag(flags, 'type')},文件 ${strFlag(flags, 'file')}` +
    `——Feed 一旦处理完成【无法撤回】,只能再提交一次覆盖`,
  confirmationInput: (flags) => {
    const { content } = validateFlatFileFeed(flags);
    return {
      snapshot: { feedContentSha256: createHash('sha256').update(content).digest('hex') },
      input: content,
    };
  },
  dryRun: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const { content, lines } = validateFlatFileFeed(ctx.flags);
    return {
      dry_run_note:
        '仅完成本地 TSV 格式检查与内容预览，没有上传或提交到亚马逊；' +
        '这不代表亚马逊已完成业务校验。真正提交请在 15 分钟内携带 meta.preview_token，' +
        '由人工在终端执行(会要求输入确认码)',
      marketplace: mkt.country,
      feedType: strFlag(ctx.flags, 'type'),
      file: strFlag(ctx.flags, 'file'),
      totalLines: lines.length,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      headerPreview: lines[0]?.slice(0, 300) ?? '',
      firstDataRow: lines[1]?.slice(0, 300) ?? '',
    };
  },
  execute: async (ctx) => {
    const mkt = resolveMarketplace(ctx.flags['marketplace']);
    const feedType = strFlag(ctx.flags, 'type')!;
    const content =
      typeof ctx.confirmedInput === 'string' ? ctx.confirmedInput : readFeedFile(ctx.flags);
    const feedDocumentId = await uploadFeedDocument(ctx, content, mkt.region);

    ctx.progress('· 正在提交 feed(此步骤之后无法撤回)...');
    const resp = (await ctx.client.request('POST', '/feeds/2021-06-30/feeds', {
      region: mkt.region,
      body: {
        feedType,
        marketplaceIds: [mkt.id],
        inputFeedDocumentId: feedDocumentId,
      },
    })) as { feedId?: string };

    return {
      feedId: resp.feedId,
      next: `用 feed status --feed-id ${resp.feedId} 查处理进度;DONE 后用 feed result --feed-id ${resp.feedId} 看处理结果`,
    };
  },
};

export const feedStatus: ToolDefinition = {
  service: 'feed',
  command: 'status',
  description: '查询 feed 处理进度',
  mutation: 'none',
  flags: [
    { name: 'feed-id', desc: 'feed submit 返回的编号(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
  ],
  execute: async (ctx) => {
    const feedId = strFlag(ctx.flags, 'feedId')!;
    return (await ctx.client.get(
      `/feeds/2021-06-30/feeds/${encodeURIComponent(feedId)}`,
      undefined,
      optionalRegion(ctx.flags),
    )) as Record<string, unknown>;
  },
};

export const feedResult: ToolDefinition = {
  service: 'feed',
  command: 'result',
  description: '下载 feed 处理结果(哪些行成功/失败及原因)',
  mutation: 'none',
  flags: [
    { name: 'feed-id', desc: 'feed 编号(必填)', required: true },
    OPTIONAL_MARKETPLACE_FLAG,
  ],
  execute: async (ctx) => {
    const feedId = strFlag(ctx.flags, 'feedId')!;
    const region = optionalRegion(ctx.flags);
    const feed = (await ctx.client.get(
      `/feeds/2021-06-30/feeds/${encodeURIComponent(feedId)}`,
      undefined,
      region,
    )) as { processingStatus?: string; resultFeedDocumentId?: string };

    if (!feed.resultFeedDocumentId) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'feed.result_not_ready',
        param: '--feed-id',
        hintAgent: 'backoff_and_retry',
        hintHuman: `feed 还没有结果文档(当前状态 ${feed.processingStatus}),请稍后再查。`,
        message: `feed ${feedId} has no resultFeedDocumentId yet (status: ${feed.processingStatus})`,
        retryable: true,
      });
    }

    const doc = (await ctx.client.get(
      `/feeds/2021-06-30/documents/${encodeURIComponent(feed.resultFeedDocumentId)}`,
      undefined,
      region,
    )) as { url?: string; compressionAlgorithm?: string };
    if (!doc.url) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'feed.no_result_url',
        hintAgent: 'report_to_human',
        hintHuman: '亚马逊没有返回结果下载地址,请稍后重试。',
        message: 'getFeedDocument returned no url',
      });
    }
    const buf = await fetchDocumentBuffer(doc.url, {
      gzip: doc.compressionAlgorithm === 'GZIP',
      what: 'feed 处理结果',
      subtype: 'feed.result_download_failed',
    });
    return {
      feedId,
      processingStatus: feed.processingStatus,
      result: buf.toString('utf8').slice(0, 50_000),
    };
  },
};
