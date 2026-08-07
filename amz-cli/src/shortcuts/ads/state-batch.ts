// ads state-batch —— 批量启用/暂停广告活动(一次预览整批 before→after,人审一次,令牌绑死整批)
//
// 背景:ads performance 查出一批要暂停的烧钱 campaign 后,单个 campaign-state 要人点 N 次。
//   这里收成一条批量写:改动来自 [{campaignId,state}] 清单(CLI --file / MCP --changes)。
//   预览列出整批"当前→目标"状态,标 no-change/not-found;人审一次;令牌绑定整批内容 +
//   全部 campaign 的远端当前状态,任一变化都令旧令牌失效。执行按片 PUT、失败隔离。
//   只支持 ENABLED/PAUSED(互相可逆);ARCHIVED 不可恢复,不开放。
//
// 依据(复用 ads/campaign-state.ts / campaign-budget.ts 已核实的接口):
//   POST /sp/campaigns/list  按 campaignIdFilter 批量读当前状态
//   PUT  /sp/campaigns       批量改状态(body {campaigns:[{campaignId,state}]})

import { readFileSync } from 'node:fs';
import { AmzError } from '../../internal/errs/errors.js';
import { AdsClient, ADS_CONTENT_TYPES } from '../../internal/client/ads-client.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion, adsResponseGroup, requireProfileId } from './common.js';

/** 单次批量上限(项目决策:一次最多 100 条)。 */
export const MAX_STATE_BATCH = 100;
const PUT_CHUNK = 100;
/** list 翻页熔断上限(照 campaign-extend listAll 的写法,防 nextToken 死循环)。 */
const MAX_LIST_PAGES = 100;

export type CampaignState = 'ENABLED' | 'PAUSED';

export interface StateChange {
  campaignId: string;
  state: CampaignState;
}

export interface CurrentCampaign {
  campaignId: string;
  state?: string;
  name?: string;
}

export type StateRowStatus = 'change' | 'no-change' | 'not-found' | 'not-applicable';

export interface StatePlanRow {
  campaignId: string;
  name?: string;
  currentState?: string;
  newState: CampaignState;
  status: StateRowStatus;
  /** 仅 not-applicable 时给出原因(如已归档)。 */
  reason?: string;
}

export interface StatePlan {
  rows: StatePlanRow[];
  willChange: StateChange[];
  noChange: StateChange[];
  notFound: StateChange[];
  /** 当前已 ARCHIVED 的 campaign:归档不可逆,执行必被拒,预览就剔除,不进 willChange。 */
  notApplicable: StateChange[];
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

/** 纯校验:规范成 StateChange[](校验、去重、排序)。不接触 IO,便于单测。 */
export function parseStateChanges(raw: unknown): StateChange[] {
  if (!Array.isArray(raw)) {
    throw invalid('ads.state_batch_not_array', '状态清单必须是数组:[{"campaignId":"…","state":"PAUSED"}, …]', 'state changes must be a JSON array');
  }
  if (raw.length === 0) {
    throw invalid('ads.state_batch_empty', '状态清单为空。', 'state changes array is empty');
  }
  if (raw.length > MAX_STATE_BATCH) {
    throw invalid('ads.state_batch_too_large', `一次最多 ${MAX_STATE_BATCH} 个广告活动(收到 ${raw.length}),请拆批。`, `state changes exceed max ${MAX_STATE_BATCH}: got ${raw.length}`);
  }
  const seen = new Set<string>();
  const out: StateChange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid('ads.state_batch_bad_item', '清单每一项必须是 {campaignId, state} 对象。', `bad item in state changes: ${JSON.stringify(item).slice(0, 120)}`);
    }
    const rec = item as Record<string, unknown>;
    const campaignId = rec['campaignId'] != null ? String(rec['campaignId']) : '';
    if (!/^\d+$/.test(campaignId)) {
      throw invalid('ads.state_batch_bad_id', `campaignId 必须是纯数字(收到 "${campaignId}")。`, `invalid campaignId: ${campaignId}`);
    }
    const state = rec['state'] != null ? String(rec['state']).toUpperCase() : '';
    if (state !== 'ENABLED' && state !== 'PAUSED') {
      throw invalid('ads.state_batch_bad_state', `state 只能是 ENABLED 或 PAUSED(收到 "${state}");ARCHIVED 不可恢复,不开放。`, `invalid state for ${campaignId}: ${state}`);
    }
    if (seen.has(campaignId)) {
      throw invalid('ads.state_batch_duplicate', `campaignId ${campaignId} 在清单里重复。`, `duplicate campaignId in state changes: ${campaignId}`);
    }
    seen.add(campaignId);
    out.push({ campaignId, state: state as CampaignState });
  }
  return out.sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0));
}

/**
 * 纯函数:对齐目标状态与远端当前状态,分出真正要改 / 无变化 / 找不到 / 不可操作。
 * 当前 ARCHIVED 判为 not-applicable(归档不可逆,改状态必被拒,预览就剔除)。
 */
export function planStateChanges(changes: StateChange[], current: CurrentCampaign[]): StatePlan {
  const byId = new Map<string, CurrentCampaign>();
  for (const c of current) byId.set(String(c.campaignId), c);

  const rows: StatePlanRow[] = [];
  const willChange: StateChange[] = [];
  const noChange: StateChange[] = [];
  const notFound: StateChange[] = [];
  const notApplicable: StateChange[] = [];

  for (const ch of changes) {
    const cur = byId.get(ch.campaignId);
    if (!cur) {
      rows.push({ campaignId: ch.campaignId, newState: ch.state, status: 'not-found' });
      notFound.push(ch);
      continue;
    }
    const currentState = cur.state != null ? String(cur.state) : undefined;
    const row: StatePlanRow = {
      campaignId: ch.campaignId,
      name: cur.name,
      currentState,
      newState: ch.state,
      status: 'change',
    };
    if (currentState?.toUpperCase() === 'ARCHIVED') {
      row.status = 'not-applicable';
      row.reason = '广告活动已归档(ARCHIVED 不可逆),无法启用/暂停';
      notApplicable.push(ch);
    } else if (currentState === ch.state) {
      row.status = 'no-change';
      noChange.push(ch);
    } else {
      willChange.push(ch);
    }
    rows.push(row);
  }
  return { rows, willChange, noChange, notFound, notApplicable };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function readStateChangesFromFlags(flags: Record<string, unknown>): StateChange[] {
  const file = strFlag(flags, 'file');
  const inline = strFlag(flags, 'changes');
  if (file && inline) {
    throw invalid('ads.state_batch_input_conflict', '--file 和 --changes 只能二选一。', 'provide either --file or --changes, not both');
  }
  let text: string;
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw invalid('ads.state_batch_file_unreadable', `读不到状态清单文件:${file}`, `cannot read --file ${file}: ${err instanceof Error ? err.message : String(err)}`, '--file');
    }
  } else if (inline) {
    text = inline;
  } else {
    throw invalid('ads.state_batch_no_input', '缺少状态清单:CLI 用 --file <清单.json>,MCP 用 --changes <JSON>。', 'missing --file or --changes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid('ads.state_batch_bad_json', '状态清单不是合法 JSON。', `state changes JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseStateChanges(parsed);
}

function asCurrentArray(value: unknown): CurrentCampaign[] {
  return Array.isArray(value) ? (value as CurrentCampaign[]) : [];
}

/**
 * 批量读当前 campaign 状态(按 100 分片查 campaignIdFilter,合并并排序)。
 * 每片带 maxResults 并处理 nextToken 翻页(带页数熔断):否则接近 100 条时
 * 后续 campaign 会被误判 not-found 而静默跳过。导出仅为单测。
 */
export async function fetchCurrentCampaigns(
  client: AdsClient,
  profileId: string,
  ids: string[],
  region?: 'na' | 'eu' | 'fe',
): Promise<CurrentCampaign[]> {
  const out: CurrentCampaign[] = [];
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
        out.push({
          campaignId: String(c['campaignId']),
          state: c['state'] != null ? String(c['state']) : undefined,
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
        subtype: 'ads.state_batch_pagination_limit',
        hintAgent: 'report_to_human',
        hintHuman: '读取当前广告活动状态时分页超过安全上限,已停止,未执行任何写入。',
        message: `state-batch campaign list pagination exceeded ${MAX_LIST_PAGES} pages`,
      });
    }
  }
  return out.sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0));
}

export const adsStateBatch: ToolDefinition = {
  service: 'ads',
  command: 'state-batch',
  description:
    '批量启用/暂停广告活动:改动来自 [{campaignId,state}] 清单(CLI --file / MCP --changes),' +
    '一次预览整批当前→目标状态,人审一次,--confirm 按片执行、失败隔离。写操作:--dry-run → --confirm',
  mutation: 'reversible',
  flags: [
    { name: 'profile-id', desc: '广告账户 profileId(必填)', required: true },
    ADS_REGION_FLAG,
    { name: 'file', desc: `状态清单 JSON 文件:[{"campaignId":"…","state":"PAUSED"}, …](与 --changes 二选一,最多 ${MAX_STATE_BATCH} 个;state 仅 ENABLED/PAUSED)` },
    { name: 'changes', desc: '内联状态清单 JSON(MCP 用,与 --file 二选一)' },
  ],
  validate: (flags) => {
    requireProfileId(flags);
    readStateChangesFromFlags(flags);
  },
  describe: (flags) => {
    const changes = readStateChangesFromFlags(flags);
    const enable = changes.filter((c) => c.state === 'ENABLED').length;
    const pause = changes.filter((c) => c.state === 'PAUSED').length;
    return `批量修改 ${changes.length} 个广告活动状态(启用 ${enable} / 暂停 ${pause},profile ${strFlag(flags, 'profileId')})——启用会立即开始花钱`;
  },
  confirmationInput: (flags) => {
    const changes = readStateChangesFromFlags(flags);
    return { snapshot: changes, input: changes };
  },
  confirmationStateSnapshot: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const ids = readStateChangesFromFlags(ctx.flags).map((c) => c.campaignId);
    return fetchCurrentCampaigns(ctx.adsClient, profileId, ids, adsRegion(ctx.flags));
  },
  dryRun: async (ctx) => {
    const changes = readStateChangesFromFlags(ctx.flags);
    const plan = planStateChanges(changes, asCurrentArray(ctx.confirmationState));
    if (plan.willChange.length === 0) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.state_batch_no_change',
        hintAgent: 'report_to_human',
        hintHuman:
          `清单里没有需要实际修改的广告活动(无变化 ${plan.noChange.length} 个、找不到 ${plan.notFound.length} 个、已归档 ${plan.notApplicable.length} 个),不签发确认令牌。`,
        message: `state-batch produced no effective change (noChange=${plan.noChange.length}, notFound=${plan.notFound.length}, notApplicable=${plan.notApplicable.length})`,
      });
    }
    const willEnable = plan.willChange.filter((c) => c.state === 'ENABLED').length;
    return {
      dry_run_note: '请人工核对以下整批状态改动;确认后凭本次预览令牌一次性执行,期间任一活动状态变化都会使令牌失效。',
      requested: changes.length,
      willChange: plan.willChange.length,
      willEnable,
      noChange: plan.noChange.length,
      notFound: plan.notFound.length,
      notApplicable: plan.notApplicable.length,
      ...(plan.notApplicable.length > 0
        ? { not_applicable_note: '已归档(ARCHIVED)的广告活动不可逆、无法启用/暂停,已从执行清单剔除。' }
        : {}),
      ...(willEnable > 0 ? { effect: `⚠️ 其中 ${willEnable} 个将被【启用】,立即开始投放花钱` } : {}),
      rows: plan.rows,
    };
  },
  execute: async (ctx) => {
    const profileId = requireProfileId(ctx.flags);
    const region = adsRegion(ctx.flags);
    const confirmed = Array.isArray(ctx.confirmedInput)
      ? (ctx.confirmedInput as StateChange[])
      : readStateChangesFromFlags(ctx.flags);
    const plan = planStateChanges(confirmed, asCurrentArray(ctx.confirmationState));
    const toApply = plan.willChange;

    const applied: Array<{ campaignId: string; state: CampaignState }> = [];
    const failed: Array<{ campaignId: string; reason: string }> = [];
    // 结果不明 ≠ 失败:网络中断(write_result_unknown)或响应形状未知时,写入可能已生效,
    // 与确定性失败分开统计,防止被当成"失败"直接重跑。
    const resultUnknown: Array<{ campaignId: string; reason: string }> = [];

    for (const part of chunk(toApply, PUT_CHUNK)) {
      ctx.progress(`· 正在写入 ${applied.length + part.length}/${toApply.length} 个状态...`);
      try {
        const resp = await ctx.adsClient.request('PUT', '/sp/campaigns', {
          profileId,
          region,
          contentType: ADS_CONTENT_TYPES.spCampaign,
          body: { campaigns: part.map((c) => ({ campaignId: c.campaignId, state: c.state })) },
          extraHeaders: { Prefer: 'return=representation' },
        });
        const group = adsResponseGroup(resp, 'campaigns');
        if (!group.known) {
          for (const c of part) resultUnknown.push({ campaignId: c.campaignId, reason: 'UNKNOWN_RESPONSE_SHAPE' });
          continue;
        }
        const okIds = new Set(group.success.map((s) => String(s['campaignId'])));
        for (const c of part) {
          if (okIds.has(c.campaignId)) applied.push({ campaignId: c.campaignId, state: c.state });
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
      notApplicable: plan.notApplicable.length,
      applied,
      ...(failed.length > 0 ? { failed } : {}),
      ...(resultUnknown.length > 0 ? { resultUnknown } : {}),
      ...(resultUnknown.length > 0
        ? {
            result_unknown_note:
              '⚠️ resultUnknown 中的广告活动写入结果不明(网络中断或响应无法识别),状态可能已经改成功——' +
              '尤其"启用"可能已在花钱。不要直接重跑;请先用 ads campaigns 或广告后台核对当前状态,再决定是否重新预览。',
          }
        : {}),
      ...(failed.length > 0
        ? { note: '部分广告活动未成功(见 failed)。不要自动重试整批;只对失败项重新预览或到后台核对。' }
        : {}),
    };
  },
};
