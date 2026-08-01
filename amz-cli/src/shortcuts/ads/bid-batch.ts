// ads bid-batch —— 批量修改关键词竞价(一次预览整批 before→after,人审一次,令牌绑死整批)
//
// 背景:ads performance / wasted-spend 查出一批要降/调竞价的关键词后,单个 keyword-bid
//   要人点 N 次。这里收成一条批量写:改动来自一份 [{keywordId,bid}] 清单
//   (CLI 用 --file 传文件;MCP 用 --changes 传内联 JSON,便于 Agent 直接由读命令输出生成)。
//   预览把整批"当前→新"竞价列出来,标出 no-change / not-found;人审一次;
//   令牌绑定整批内容 + 全部关键词的远端当前竞价,任一变化都令旧令牌失效。
//   执行按 100 一片分片 PUT,按片解析 multistatus,失败隔离、逐项汇总,不整批中断。
//
// 依据(复用 ads/keywords.ts 已核实的接口):
//   POST /sp/keywords/list  按 keywordIdFilter 批量读当前竞价
//   PUT  /sp/keywords       批量调竞价(body {keywords:[{keywordId,bid}]})

import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import { AdsClient, ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import {
  ADS_REGION_FLAG,
  adsRegion,
  adsResponseGroup,
  requireProfileId,
} from './common.js';

/** 单次批量上限:限制一次审批覆盖的写入量(项目决策:一次最多 100 条),过大拆多次跑。 */
export const MAX_BID_BATCH = 100;
/** 每次 PUT 的分片大小(与批量上限一致,单批一次写完)。 */
const PUT_CHUNK = 100;

export interface BidChange {
  keywordId: string;
  bid: number;
}

export interface CurrentKeyword {
  keywordId: string;
  bid?: number;
  state?: string;
  keywordText?: string;
}

export type BidRowStatus = 'change' | 'no-change' | 'not-found';

export interface BidPlanRow {
  keywordId: string;
  keywordText?: string;
  state?: string;
  currentBid?: number;
  newBid: number;
  status: BidRowStatus;
}

export interface BidPlan {
  rows: BidPlanRow[];
  willChange: BidChange[];
  noChange: BidChange[];
  notFound: BidChange[];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function invalid(subtype: string, hintHuman: string, message: string, param?: string): AmzError {
  return new AmzError({
    type: 'invalid_param',
    subtype,
    ...(param ? { param } : {}),
    hintAgent: 'fix_param',
    hintHuman,
    message,
  });
}

/**
 * 纯校验:把原始清单规范成 BidChange[](去重、排序、范围校验)。
 * 不接触 IO,便于单测。
 */
export function parseBidChanges(raw: unknown): BidChange[] {
  if (!Array.isArray(raw)) {
    throw invalid('ads.bid_batch_not_array', '竞价清单必须是数组:[{"keywordId":"…","bid":0.85}, …]', 'bid changes must be a JSON array');
  }
  if (raw.length === 0) {
    throw invalid('ads.bid_batch_empty', '竞价清单为空,没有要修改的关键词。', 'bid changes array is empty');
  }
  if (raw.length > MAX_BID_BATCH) {
    throw invalid(
      'ads.bid_batch_too_large',
      `一次最多 ${MAX_BID_BATCH} 个关键词(收到 ${raw.length}),请拆成多批。`,
      `bid changes exceed max ${MAX_BID_BATCH}: got ${raw.length}`,
    );
  }
  const seen = new Set<string>();
  const out: BidChange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid('ads.bid_batch_bad_item', '清单每一项必须是 {keywordId, bid} 对象。', `bad item in bid changes: ${JSON.stringify(item).slice(0, 120)}`);
    }
    const rec = item as Record<string, unknown>;
    const keywordId = rec['keywordId'] != null ? String(rec['keywordId']) : '';
    if (!/^\d+$/.test(keywordId)) {
      throw invalid('ads.bid_batch_bad_id', `keywordId 必须是纯数字(收到 "${keywordId}")。`, `invalid keywordId: ${keywordId}`);
    }
    const bid = Number(rec['bid']);
    if (!Number.isFinite(bid) || bid <= 0 || bid > 10_000) {
      throw invalid('ads.bid_batch_bad_bid', `keyword ${keywordId} 的 bid 必须是 0~10000 的正数(收到 "${String(rec['bid'])}")。`, `invalid bid for ${keywordId}: ${String(rec['bid'])}`);
    }
    if (seen.has(keywordId)) {
      throw invalid('ads.bid_batch_duplicate', `keywordId ${keywordId} 在清单里重复,一个关键词只能有一个目标竞价。`, `duplicate keywordId in bid changes: ${keywordId}`);
    }
    seen.add(keywordId);
    out.push({ keywordId, bid: round2(bid) });
  }
  // 排序让快照/哈希稳定,与输入顺序无关
  return out.sort((a, b) => (a.keywordId < b.keywordId ? -1 : a.keywordId > b.keywordId ? 1 : 0));
}

/**
 * 纯函数:把目标竞价和远端当前竞价对齐成 before→after,分出真正要改 / 无变化 / 找不到。
 * currentBid === newBid(两位小数)判为 no-change;远端缺该关键词判为 not-found。
 */
export function planBidChanges(changes: BidChange[], current: CurrentKeyword[]): BidPlan {
  const byId = new Map<string, CurrentKeyword>();
  for (const c of current) byId.set(String(c.keywordId), c);

  const rows: BidPlanRow[] = [];
  const willChange: BidChange[] = [];
  const noChange: BidChange[] = [];
  const notFound: BidChange[] = [];

  for (const ch of changes) {
    const cur = byId.get(ch.keywordId);
    if (!cur) {
      rows.push({ keywordId: ch.keywordId, newBid: ch.bid, status: 'not-found' });
      notFound.push(ch);
      continue;
    }
    const currentBid = cur.bid != null ? round2(Number(cur.bid)) : undefined;
    const base: BidPlanRow = {
      keywordId: ch.keywordId,
      keywordText: cur.keywordText,
      state: cur.state,
      currentBid,
      newBid: ch.bid,
      status: 'change',
    };
    if (currentBid === ch.bid) {
      base.status = 'no-change';
      noChange.push(ch);
    } else {
      willChange.push(ch);
    }
    rows.push(base);
  }
  return { rows, willChange, noChange, notFound };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 读取 --file(路径)或 --changes(内联 JSON),解析并规范成 BidChange[]。 */
function readBidChangesFromFlags(flags: Record<string, unknown>): BidChange[] {
  const file = strFlag(flags, 'file');
  const inline = strFlag(flags, 'changes');
  if (file && inline) {
    throw invalid('ads.bid_batch_input_conflict', '--file 和 --changes 只能二选一。', 'provide either --file or --changes, not both');
  }
  let text: string;
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw invalid('ads.bid_batch_file_unreadable', `读不到竞价清单文件:${file}`, `cannot read --file ${file}: ${err instanceof Error ? err.message : String(err)}`, '--file');
    }
  } else if (inline) {
    text = inline;
  } else {
    throw invalid('ads.bid_batch_no_input', '缺少竞价清单:CLI 用 --file <清单.json>,MCP 用 --changes <JSON>。', 'missing --file or --changes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid('ads.bid_batch_bad_json', '竞价清单不是合法 JSON。', `bid changes JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseBidChanges(parsed);
}

function asCurrentArray(value: unknown): CurrentKeyword[] {
  return Array.isArray(value) ? (value as CurrentKeyword[]) : [];
}

/** 批量读当前关键词竞价(按 100 分片查 keywordIdFilter,合并并按 id 排序)。 */
async function fetchCurrentKeywords(
  client: AdsClient,
  profileId: string,
  ids: string[],
  region?: 'na' | 'eu' | 'fe',
): Promise<CurrentKeyword[]> {
  const out: CurrentKeyword[] = [];
  for (const idChunk of chunk(ids, PUT_CHUNK)) {
    const resp = (await client.request('POST', '/sp/keywords/list', {
      profileId,
      region,
      contentType: ADS_CONTENT_TYPES.spKeyword,
      retry5xx: true,
      body: { keywordIdFilter: { include: idChunk }, maxResults: idChunk.length },
    })) as { keywords?: Array<Record<string, unknown>> } | null;
    for (const k of resp?.keywords ?? []) {
      out.push({
        keywordId: String(k['keywordId']),
        bid: k['bid'] != null ? Number(k['bid']) : undefined,
        state: k['state'] != null ? String(k['state']) : undefined,
        keywordText: k['keywordText'] != null ? String(k['keywordText']) : undefined,
      });
    }
  }
  return out.sort((a, b) => (a.keywordId < b.keywordId ? -1 : a.keywordId > b.keywordId ? 1 : 0));
}

export const adsBidBatch: ToolDefinition = {
  service: 'ads',
  command: 'bid-batch',
  description:
    '批量修改关键词竞价:改动来自 [{keywordId,bid}] 清单(CLI --file / MCP --changes),' +
    '一次预览整批当前→新竞价,人审一次,--confirm 按片执行、失败隔离。写操作:--dry-run → --confirm',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'file', desc: `竞价清单 JSON 文件:[{"keywordId":"…","bid":0.85}, …](与 --changes 二选一,最多 ${MAX_BID_BATCH} 个)` },
    { name: 'changes', desc: '内联竞价清单 JSON(MCP 用,与 --file 二选一)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    readBidChangesFromFlags(flags); // 尽早报清单/格式错误
  },
  describe: (flags) => {
    const n = readBidChangesFromFlags(flags).length;
    return `批量修改 ${n} 个关键词的竞价(profile ${strFlag(flags, 'profileId')})——预览会列出每个"当前→新"竞价供核对`;
  },
  confirmationInput: (flags) => {
    const changes = readBidChangesFromFlags(flags);
    return { snapshot: changes, input: changes };
  },
  confirmationStateSnapshot: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const ids = readBidChangesFromFlags(ctx.flags).map((c) => c.keywordId);
    return fetchCurrentKeywords(ctx.adsClient, profileId, ids, adsRegion(ctx.flags));
  },
  dryRun: async (ctx) => {
    const changes = readBidChangesFromFlags(ctx.flags);
    const plan = planBidChanges(changes, asCurrentArray(ctx.confirmationState));
    if (plan.willChange.length === 0) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.bid_batch_no_change',
        hintAgent: 'report_to_human',
        hintHuman:
          `清单里没有需要实际修改的关键词(无变化 ${plan.noChange.length} 个、找不到 ${plan.notFound.length} 个),不签发确认令牌。` +
          '请核对 keywordId 和目标竞价。',
        message: `bid-batch produced no effective change (noChange=${plan.noChange.length}, notFound=${plan.notFound.length})`,
      });
    }
    return {
      dry_run_note: '请人工核对以下整批竞价改动;确认后凭本次预览令牌一次性执行,期间任一关键词当前竞价变化都会使令牌失效。',
      requested: changes.length,
      willChange: plan.willChange.length,
      noChange: plan.noChange.length,
      notFound: plan.notFound.length,
      rows: plan.rows,
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const region = adsRegion(ctx.flags);
    const confirmed = Array.isArray(ctx.confirmedInput)
      ? (ctx.confirmedInput as BidChange[])
      : readBidChangesFromFlags(ctx.flags);
    const plan = planBidChanges(confirmed, asCurrentArray(ctx.confirmationState));
    const toApply = plan.willChange;

    const applied: Array<{ keywordId: string; bid: number }> = [];
    const failed: Array<{ keywordId: string; reason: string }> = [];

    for (const part of chunk(toApply, PUT_CHUNK)) {
      ctx.progress(`· 正在写入 ${applied.length + part.length}/${toApply.length} 个竞价...`);
      try {
        const resp = await ctx.adsClient.request('PUT', '/sp/keywords', {
          profileId,
          region,
          contentType: ADS_CONTENT_TYPES.spKeyword,
          body: { keywords: part.map((c) => ({ keywordId: c.keywordId, bid: c.bid })) },
          extraHeaders: { Prefer: 'return=representation' },
        });
        const group = adsResponseGroup(resp, 'keywords');
        if (!group.known) {
          // 响应形状未知:不武断判成功也不判失败,如实标出待人工核对
          for (const c of part) failed.push({ keywordId: c.keywordId, reason: 'UNKNOWN_RESPONSE_SHAPE' });
          continue;
        }
        const okIds = new Set(group.success.map((s) => String(s['keywordId'])));
        for (const c of part) {
          if (okIds.has(c.keywordId)) applied.push({ keywordId: c.keywordId, bid: c.bid });
          else failed.push({ keywordId: c.keywordId, reason: 'REJECTED_BY_AMAZON' });
        }
      } catch (err) {
        // 整片请求失败(如网络):该片全部计为失败,继续下一片,不中断整批
        const reason = err instanceof Error ? err.message : String(err);
        for (const c of part) failed.push({ keywordId: c.keywordId, reason: reason.slice(0, 200) });
      }
    }

    return {
      profileId,
      requested: confirmed.length,
      attempted: toApply.length,
      appliedCount: applied.length,
      failedCount: failed.length,
      noChange: plan.noChange.length,
      notFound: plan.notFound.length,
      applied,
      ...(failed.length > 0 ? { failed } : {}),
      ...(failed.length > 0
        ? {
            note:
              '部分关键词未成功(见 failed)。不要自动重试整批;请只对失败项重新预览,' +
              '或到广告后台核对后处理。',
          }
        : {}),
    };
  },
};
