// ads budget-batch —— 批量修改广告活动日预算(一次预览整批 before→after,人审一次,令牌绑死整批)
//
// 背景:ads performance 查出一批要调预算的 campaign 后,单个 campaign-budget 要人点 N 次。
//   这里收成一条批量写:改动来自 [{campaignId,dailyBudget}] 清单(CLI --file / MCP --changes)。
//   预览列出整批"当前→新"日预算,标 no-change/not-found;人审一次;令牌绑定整批内容 +
//   全部 campaign 的远端当前预算,任一变化都令旧令牌失效。执行按片 PUT、失败隔离。
//
// 依据(复用 ads/campaign-budget.ts 已核实的接口):
//   POST /sp/campaigns/list  按 campaignIdFilter 批量读当前预算(current.budget.budget)
//   PUT  /sp/campaigns       批量改预算(body {campaigns:[{campaignId,budget:{budgetType:'DAILY',budget}}]})

import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import { AdsClient, ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion, adsResponseGroup, requireProfileId, round2 } from './common.js';

/** 单次批量上限(项目决策:一次最多 100 条)。 */
export const MAX_BUDGET_BATCH = 100;
const PUT_CHUNK = 100;
/** list 翻页熔断上限(照 campaign-extend listAll 的写法,防 nextToken 死循环)。 */
const MAX_LIST_PAGES = 100;

export interface BudgetChange {
  campaignId: string;
  dailyBudget: number;
}

export interface CurrentCampaignBudget {
  campaignId: string;
  dailyBudget?: number;
  name?: string;
}

export type BudgetRowStatus = 'change' | 'no-change' | 'not-found';

export interface BudgetPlanRow {
  campaignId: string;
  name?: string;
  currentBudget?: number;
  newBudget: number;
  status: BudgetRowStatus;
}

export interface BudgetPlan {
  rows: BudgetPlanRow[];
  willChange: BudgetChange[];
  noChange: BudgetChange[];
  notFound: BudgetChange[];
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

/** 纯校验:规范成 BudgetChange[](校验、去重、排序)。不接触 IO,便于单测。 */
export function parseBudgetChanges(raw: unknown): BudgetChange[] {
  if (!Array.isArray(raw)) {
    throw invalid('ads.budget_batch_not_array', '预算清单必须是数组:[{"campaignId":"…","dailyBudget":20}, …]', 'budget changes must be a JSON array');
  }
  if (raw.length === 0) {
    throw invalid('ads.budget_batch_empty', '预算清单为空。', 'budget changes array is empty');
  }
  if (raw.length > MAX_BUDGET_BATCH) {
    throw invalid('ads.budget_batch_too_large', `一次最多 ${MAX_BUDGET_BATCH} 个广告活动(收到 ${raw.length}),请拆批。`, `budget changes exceed max ${MAX_BUDGET_BATCH}: got ${raw.length}`);
  }
  const seen = new Set<string>();
  const out: BudgetChange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid('ads.budget_batch_bad_item', '清单每一项必须是 {campaignId, dailyBudget} 对象。', `bad item in budget changes: ${JSON.stringify(item).slice(0, 120)}`);
    }
    const rec = item as Record<string, unknown>;
    const campaignId = rec['campaignId'] != null ? String(rec['campaignId']) : '';
    if (!/^\d+$/.test(campaignId)) {
      throw invalid('ads.budget_batch_bad_id', `campaignId 必须是纯数字(收到 "${campaignId}")。`, `invalid campaignId: ${campaignId}`);
    }
    // 兼容 dailyBudget / budget 两种键名
    const budgetRaw = rec['dailyBudget'] ?? rec['budget'];
    const budget = Number(budgetRaw);
    if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000) {
      throw invalid('ads.budget_batch_bad_budget', `campaign ${campaignId} 的 dailyBudget 必须是 0~1000000 的正数(收到 "${String(budgetRaw)}")。`, `invalid dailyBudget for ${campaignId}: ${String(budgetRaw)}`);
    }
    if (seen.has(campaignId)) {
      throw invalid('ads.budget_batch_duplicate', `campaignId ${campaignId} 在清单里重复。`, `duplicate campaignId in budget changes: ${campaignId}`);
    }
    seen.add(campaignId);
    out.push({ campaignId, dailyBudget: round2(budget) });
  }
  return out.sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0));
}

/** 纯函数:对齐目标预算与远端当前预算,分出真正要改 / 无变化 / 找不到。 */
export function planBudgetChanges(changes: BudgetChange[], current: CurrentCampaignBudget[]): BudgetPlan {
  const byId = new Map<string, CurrentCampaignBudget>();
  for (const c of current) byId.set(String(c.campaignId), c);

  const rows: BudgetPlanRow[] = [];
  const willChange: BudgetChange[] = [];
  const noChange: BudgetChange[] = [];
  const notFound: BudgetChange[] = [];

  for (const ch of changes) {
    const cur = byId.get(ch.campaignId);
    if (!cur) {
      rows.push({ campaignId: ch.campaignId, newBudget: ch.dailyBudget, status: 'not-found' });
      notFound.push(ch);
      continue;
    }
    const currentBudget = cur.dailyBudget != null ? round2(Number(cur.dailyBudget)) : undefined;
    const row: BudgetPlanRow = {
      campaignId: ch.campaignId,
      name: cur.name,
      currentBudget,
      newBudget: ch.dailyBudget,
      status: 'change',
    };
    if (currentBudget === ch.dailyBudget) {
      row.status = 'no-change';
      noChange.push(ch);
    } else {
      willChange.push(ch);
    }
    rows.push(row);
  }
  return { rows, willChange, noChange, notFound };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function readBudgetChangesFromFlags(flags: Record<string, unknown>): BudgetChange[] {
  const file = strFlag(flags, 'file');
  const inline = strFlag(flags, 'changes');
  if (file && inline) {
    throw invalid('ads.budget_batch_input_conflict', '--file 和 --changes 只能二选一。', 'provide either --file or --changes, not both');
  }
  let text: string;
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw invalid('ads.budget_batch_file_unreadable', `读不到预算清单文件:${file}`, `cannot read --file ${file}: ${err instanceof Error ? err.message : String(err)}`, '--file');
    }
  } else if (inline) {
    text = inline;
  } else {
    throw invalid('ads.budget_batch_no_input', '缺少预算清单:CLI 用 --file <清单.json>,MCP 用 --changes <JSON>。', 'missing --file or --changes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid('ads.budget_batch_bad_json', '预算清单不是合法 JSON。', `budget changes JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseBudgetChanges(parsed);
}

function asCurrentArray(value: unknown): CurrentCampaignBudget[] {
  return Array.isArray(value) ? (value as CurrentCampaignBudget[]) : [];
}

/**
 * 批量读当前 campaign 日预算(按 100 分片查 campaignIdFilter,合并并排序)。
 * 每片带 maxResults 并处理 nextToken 翻页(带页数熔断):否则接近 100 条时
 * 后续 campaign 会被误判 not-found 而静默跳过。导出仅为单测。
 */
export async function fetchCurrentBudgets(
  client: AdsClient,
  profileId: string,
  ids: string[],
  region?: 'na' | 'eu' | 'fe',
): Promise<CurrentCampaignBudget[]> {
  const out: CurrentCampaignBudget[] = [];
  for (const idChunk of chunk(ids, PUT_CHUNK)) {
    let nextToken: string | undefined;
    let exhausted = false;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const resp = (await client.request('POST', '/sp/campaigns/list', {
        profileId,
        region,
        contentType: ADS_CONTENT_TYPES.spCampaign,
        retry5xx: true,
        body: {
          campaignIdFilter: { include: idChunk },
          maxResults: idChunk.length,
          ...(nextToken ? { nextToken } : {}),
        },
      })) as { campaigns?: Array<Record<string, unknown>>; nextToken?: string } | null;
      for (const c of resp?.campaigns ?? []) {
        const budgetObj = c['budget'] as Record<string, unknown> | undefined;
        const dailyBudget = budgetObj?.['budget'] != null ? Number(budgetObj['budget']) : undefined;
        out.push({
          campaignId: String(c['campaignId']),
          dailyBudget,
          name: c['name'] != null ? String(c['name']) : undefined,
        });
      }
      nextToken = typeof resp?.nextToken === 'string' && resp.nextToken ? resp.nextToken : undefined;
      if (!nextToken) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted) {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'ads.budget_batch_pagination_limit',
        hintAgent: 'report_to_human',
        hintHuman: '读取当前广告活动预算时分页超过安全上限,已停止,未执行任何写入。',
        message: `budget-batch campaign list pagination exceeded ${MAX_LIST_PAGES} pages`,
      });
    }
  }
  return out.sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0));
}

export const adsBudgetBatch: ToolDefinition = {
  service: 'ads',
  command: 'budget-batch',
  description:
    '批量修改广告活动日预算:改动来自 [{campaignId,dailyBudget}] 清单(CLI --file / MCP --changes),' +
    '一次预览整批当前→新预算,人审一次,--confirm 按片执行、失败隔离。写操作:--dry-run → --confirm',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'file', desc: `预算清单 JSON 文件:[{"campaignId":"…","dailyBudget":20}, …](与 --changes 二选一,最多 ${MAX_BUDGET_BATCH} 个)` },
    { name: 'changes', desc: '内联预算清单 JSON(MCP 用,与 --file 二选一)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    readBudgetChangesFromFlags(flags);
  },
  describe: (flags) => {
    const n = readBudgetChangesFromFlags(flags).length;
    return `批量修改 ${n} 个广告活动的日预算(profile ${strFlag(flags, 'profileId')})——预览会列出每个"当前→新"预算供核对`;
  },
  confirmationInput: (flags) => {
    const changes = readBudgetChangesFromFlags(flags);
    return { snapshot: changes, input: changes };
  },
  confirmationStateSnapshot: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const ids = readBudgetChangesFromFlags(ctx.flags).map((c) => c.campaignId);
    return fetchCurrentBudgets(ctx.adsClient, profileId, ids, adsRegion(ctx.flags));
  },
  dryRun: async (ctx) => {
    const changes = readBudgetChangesFromFlags(ctx.flags);
    const plan = planBudgetChanges(changes, asCurrentArray(ctx.confirmationState));
    if (plan.willChange.length === 0) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.budget_batch_no_change',
        hintAgent: 'report_to_human',
        hintHuman: `清单里没有需要实际修改的广告活动(无变化 ${plan.noChange.length} 个、找不到 ${plan.notFound.length} 个),不签发确认令牌。`,
        message: `budget-batch produced no effective change (noChange=${plan.noChange.length}, notFound=${plan.notFound.length})`,
      });
    }
    return {
      dry_run_note: '请人工核对以下整批预算改动;确认后凭本次预览令牌一次性执行,期间任一活动当前预算变化都会使令牌失效。',
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
      ? (ctx.confirmedInput as BudgetChange[])
      : readBudgetChangesFromFlags(ctx.flags);
    const plan = planBudgetChanges(confirmed, asCurrentArray(ctx.confirmationState));
    const toApply = plan.willChange;

    const applied: Array<{ campaignId: string; dailyBudget: number }> = [];
    const failed: Array<{ campaignId: string; reason: string }> = [];
    // 结果不明 ≠ 失败:网络中断(write_result_unknown)或响应形状未知时,写入可能已生效,
    // 与确定性失败分开统计,防止被当成"失败"直接重跑。
    const resultUnknown: Array<{ campaignId: string; reason: string }> = [];

    for (const part of chunk(toApply, PUT_CHUNK)) {
      ctx.progress(`· 正在写入 ${applied.length + part.length}/${toApply.length} 个预算...`);
      try {
        const resp = await ctx.adsClient.request('PUT', '/sp/campaigns', {
          profileId,
          region,
          contentType: ADS_CONTENT_TYPES.spCampaign,
          body: {
            campaigns: part.map((c) => ({ campaignId: c.campaignId, budget: { budgetType: 'DAILY', budget: c.dailyBudget } })),
          },
          extraHeaders: { Prefer: 'return=representation' },
        });
        const group = adsResponseGroup(resp, 'campaigns');
        if (!group.known) {
          for (const c of part) resultUnknown.push({ campaignId: c.campaignId, reason: 'UNKNOWN_RESPONSE_SHAPE' });
          continue;
        }
        const okIds = new Set(group.success.map((s) => String(s['campaignId'])));
        for (const c of part) {
          if (okIds.has(c.campaignId)) applied.push({ campaignId: c.campaignId, dailyBudget: c.dailyBudget });
          else failed.push({ campaignId: c.campaignId, reason: 'REJECTED_BY_AMAZON' });
        }
      } catch (err) {
        // 确定未发出/被拒的计入 failed;结果不明(可能已生效)单独计入 resultUnknown。
        const ambiguous = err instanceof AmzError && err.subtype === 'ads.write_result_unknown';
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        const bucket = ambiguous ? resultUnknown : failed;
        for (const c of part) bucket.push({ campaignId: c.campaignId, reason });
      }
    }

    return {
      profileId,
      requested: confirmed.length,
      attempted: toApply.length,
      appliedCount: applied.length,
      failedCount: failed.length,
      resultUnknownCount: resultUnknown.length,
      noChange: plan.noChange.length,
      notFound: plan.notFound.length,
      applied,
      ...(failed.length > 0 ? { failed } : {}),
      ...(resultUnknown.length > 0 ? { resultUnknown } : {}),
      ...(resultUnknown.length > 0
        ? {
            result_unknown_note:
              '⚠️ resultUnknown 中的广告活动写入结果不明(网络中断或响应无法识别),预算可能已经改成功。' +
              '不要直接重跑;请先用 ads campaigns 或广告后台核对当前预算,再决定是否重新预览。',
          }
        : {}),
      ...(failed.length > 0
        ? { note: '部分广告活动未成功(见 failed)。不要自动重试整批;只对失败项重新预览或到后台核对。' }
        : {}),
    };
  },
};
