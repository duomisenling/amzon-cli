// ads negative-batch —— 批量添加否定关键词(一次预览整批,人审一次,令牌绑死整批)
//
// 背景:ads wasted-spend 查出一批白花钱的搜索词后,单条 negative-keyword 要人点 N 次。
//   这里收成一条批量写:改动来自 [{campaignId,adGroupId,text,match?}] 清单
//   (CLI --file / MCP --changes,Agent 可直接拿 wasted-spend 的 terms 输出生成)。
//   否定词是"叠加型"写入(不改现值、可随时暂停/删除,可逆),没有 before→after 对照,
//   所以令牌只绑定清单内容;执行按 100 一片 POST,按 multistatus 逐项隔离、如实汇总。
//
// 依据(复用 ads/keywords.ts 已核实的接口):
//   POST /sp/negativeKeywords  批量加否定词
//     body {negativeKeywords:[{campaignId,adGroupId,keywordText,matchType,state}]}
//   注:官方否定词 list 回读接口项目未核实,不臆造,结果以创建响应为准。

import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import { ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion, adsResponseGroup, requireProfileId } from './common.js';

/** 单次批量上限(项目决策:一次最多 100 条)。 */
export const MAX_NEGATIVE_BATCH = 100;
const POST_CHUNK = 100;
/** 否定词文本长度上限(Amazon 关键词约 80 字符)。 */
const MAX_TEXT_LEN = 80;

export type NegativeMatch = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE';

export interface NegativeChange {
  campaignId: string;
  adGroupId: string;
  text: string;
  match: NegativeMatch;
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
 * 纯校验:把原始清单规范成 NegativeChange[](校验字段、去重、排序)。不接触 IO,便于单测。
 * 去重键 = campaignId|adGroupId|match|小写text。
 */
export function parseNegativeChanges(raw: unknown): NegativeChange[] {
  if (!Array.isArray(raw)) {
    throw invalid('ads.neg_batch_not_array', '否定词清单必须是数组:[{"campaignId":"…","adGroupId":"…","text":"…"}, …]', 'negative changes must be a JSON array');
  }
  if (raw.length === 0) {
    throw invalid('ads.neg_batch_empty', '否定词清单为空。', 'negative changes array is empty');
  }
  if (raw.length > MAX_NEGATIVE_BATCH) {
    throw invalid('ads.neg_batch_too_large', `一次最多 ${MAX_NEGATIVE_BATCH} 个否定词(收到 ${raw.length}),请拆批。`, `negative changes exceed max ${MAX_NEGATIVE_BATCH}: got ${raw.length}`);
  }
  const seen = new Set<string>();
  const out: NegativeChange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid('ads.neg_batch_bad_item', '清单每一项必须是 {campaignId, adGroupId, text, match?} 对象。', `bad item in negative changes: ${JSON.stringify(item).slice(0, 120)}`);
    }
    const rec = item as Record<string, unknown>;
    const campaignId = rec['campaignId'] != null ? String(rec['campaignId']) : '';
    const adGroupId = rec['adGroupId'] != null ? String(rec['adGroupId']) : '';
    if (!/^\d+$/.test(campaignId)) {
      throw invalid('ads.neg_batch_bad_campaign', `campaignId 必须是纯数字(收到 "${campaignId}")。`, `invalid campaignId: ${campaignId}`);
    }
    if (!/^\d+$/.test(adGroupId)) {
      throw invalid('ads.neg_batch_bad_adgroup', `adGroupId 必须是纯数字(收到 "${adGroupId}")。`, `invalid adGroupId: ${adGroupId}`);
    }
    const text = (rec['text'] != null ? String(rec['text']) : '').trim();
    if (text.length === 0) {
      throw invalid('ads.neg_batch_empty_text', '否定词文本不能为空。', 'negative keyword text is empty');
    }
    if (text.length > MAX_TEXT_LEN) {
      throw invalid('ads.neg_batch_text_too_long', `否定词过长(>${MAX_TEXT_LEN} 字符):"${text.slice(0, 30)}…"`, `negative keyword text too long: ${text.length}`);
    }
    const rawMatch = rec['match'] != null ? String(rec['match']).toUpperCase() : 'NEGATIVE_EXACT';
    if (rawMatch !== 'NEGATIVE_EXACT' && rawMatch !== 'NEGATIVE_PHRASE') {
      throw invalid('ads.neg_batch_bad_match', `match 只能是 NEGATIVE_EXACT 或 NEGATIVE_PHRASE(收到 "${rawMatch}")。`, `invalid match: ${rawMatch}`);
    }
    const match = rawMatch as NegativeMatch;
    const key = `${campaignId}|${adGroupId}|${match}|${text.toLowerCase()}`;
    if (seen.has(key)) {
      throw invalid('ads.neg_batch_duplicate', `清单里有重复否定词(同活动/广告组/匹配/词):"${text}"`, `duplicate negative keyword in batch: ${key}`);
    }
    seen.add(key);
    out.push({ campaignId, adGroupId, text, match });
  }
  return out.sort((a, b) => {
    const ka = `${a.campaignId}|${a.adGroupId}|${a.match}|${a.text.toLowerCase()}`;
    const kb = `${b.campaignId}|${b.adGroupId}|${b.match}|${b.text.toLowerCase()}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 组装 POST /sp/negativeKeywords 的 body(预览即所提交)。 */
export function buildNegativeKeywordsBody(changes: NegativeChange[]): {
  negativeKeywords: Array<Record<string, unknown>>;
} {
  return {
    negativeKeywords: changes.map((c) => ({
      campaignId: c.campaignId,
      adGroupId: c.adGroupId,
      keywordText: c.text,
      matchType: c.match,
      state: 'ENABLED',
    })),
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function readNegativeChangesFromFlags(flags: Record<string, unknown>): NegativeChange[] {
  const file = strFlag(flags, 'file');
  const inline = strFlag(flags, 'changes');
  if (file && inline) {
    throw invalid('ads.neg_batch_input_conflict', '--file 和 --changes 只能二选一。', 'provide either --file or --changes, not both');
  }
  let text: string;
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw invalid('ads.neg_batch_file_unreadable', `读不到否定词清单文件:${file}`, `cannot read --file ${file}: ${err instanceof Error ? err.message : String(err)}`, '--file');
    }
  } else if (inline) {
    text = inline;
  } else {
    throw invalid('ads.neg_batch_no_input', '缺少否定词清单:CLI 用 --file <清单.json>,MCP 用 --changes <JSON>。', 'missing --file or --changes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid('ads.neg_batch_bad_json', '否定词清单不是合法 JSON。', `negative changes JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseNegativeChanges(parsed);
}

export const adsNegativeBatch: ToolDefinition = {
  service: 'ads',
  command: 'negative-batch',
  description:
    '批量添加否定关键词:改动来自 [{campaignId,adGroupId,text,match?}] 清单(CLI --file / MCP --changes),' +
    '一次预览整批,人审一次,--confirm 按片创建、失败隔离。写操作:--dry-run → --confirm',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'file', desc: `否定词清单 JSON 文件:[{"campaignId":"…","adGroupId":"…","text":"…","match":"NEGATIVE_EXACT"}, …](与 --changes 二选一,最多 ${MAX_NEGATIVE_BATCH} 个;match 默认 NEGATIVE_EXACT)` },
    { name: 'changes', desc: '内联否定词清单 JSON(MCP 用,与 --file 二选一)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    readNegativeChangesFromFlags(flags);
  },
  describe: (flags) => {
    const n = readNegativeChangesFromFlags(flags).length;
    return `批量添加 ${n} 个否定关键词(profile ${strFlag(flags, 'profileId')})——预览会列出全部将创建的否定词供核对`;
  },
  confirmationInput: (flags) => {
    const changes = readNegativeChangesFromFlags(flags);
    return { snapshot: changes, input: changes };
  },
  dryRun: async (ctx) => {
    const changes = readNegativeChangesFromFlags(ctx.flags);
    return {
      dry_run_note:
        '请人工核对以下将创建的整批否定词;确认后凭本次预览令牌一次性创建。否定词可逆(可随时在后台暂停/删除)。',
      count: changes.length,
      negativeKeywords: changes.map((c) => ({
        campaignId: c.campaignId,
        adGroupId: c.adGroupId,
        text: c.text,
        match: c.match,
      })),
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const region = adsRegion(ctx.flags);
    const confirmed = Array.isArray(ctx.confirmedInput)
      ? (ctx.confirmedInput as NegativeChange[])
      : readNegativeChangesFromFlags(ctx.flags);

    let successCount = 0;
    // 结果不明 ≠ 失败:响应结构未识别,或网络中断(write_result_unknown)导致写入可能已生效。
    // 否定词是创建型写入,把这些误计入 failed 会诱导重跑而产生重复否定词,必须分开统计。
    let unknownCount = 0;
    const resultUnknownChunks: Array<{ size: number; reason: string }> = [];
    const errors: Array<Record<string, unknown>> = [];
    const failedChunks: Array<{ size: number; reason: string }> = [];

    for (const part of chunk(confirmed, POST_CHUNK)) {
      ctx.progress(`· 正在创建 ${successCount + part.length}/${confirmed.length} 个否定词...`);
      try {
        const resp = await ctx.adsClient.request('POST', '/sp/negativeKeywords', {
          profileId,
          region,
          contentType: ADS_CONTENT_TYPES.spNegativeKeyword,
          body: buildNegativeKeywordsBody(part),
          extraHeaders: { Prefer: 'return=representation' },
        });
        const group = adsResponseGroup(resp, 'negativeKeywords');
        if (!group.known) {
          unknownCount += part.length;
          continue;
        }
        successCount += group.success.length;
        errors.push(...group.error);
      } catch (err) {
        // 确定未发出/被拒的计入 failedChunks;结果不明(可能已创建)单独计入 resultUnknownChunks。
        const ambiguous = err instanceof AmzError && err.subtype === 'ads.write_result_unknown';
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        const bucket = ambiguous ? resultUnknownChunks : failedChunks;
        bucket.push({ size: part.length, reason });
      }
    }

    const failedCount = errors.length + failedChunks.reduce((s, c) => s + c.size, 0);
    const resultUnknownCount = unknownCount + resultUnknownChunks.reduce((s, c) => s + c.size, 0);
    return {
      profileId,
      requested: confirmed.length,
      successCount,
      failedCount,
      resultUnknownCount,
      ...(unknownCount > 0 ? { unknownResponseCount: unknownCount } : {}),
      ...(resultUnknownChunks.length > 0 ? { resultUnknownChunks } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(failedChunks.length > 0 ? { failedChunks } : {}),
      note:
        resultUnknownCount > 0
          ? `⚠️ 有 ${resultUnknownCount} 个否定词创建结果不明(网络中断或响应结构未识别),它们可能已经创建成功。` +
            '不要直接重跑整批——重复提交会产生重复否定词;请先到广告后台核对这些词是否已存在,只对确认缺失的词重新预览。'
          : failedCount > 0
            ? '部分否定词创建失败(见 errors/failedChunks)。不要自动重试整批;只对失败项重新预览或到后台核对。'
            : '整批否定词已提交创建。否定词可随时在后台暂停/删除(可逆)。',
    };
  },
};
