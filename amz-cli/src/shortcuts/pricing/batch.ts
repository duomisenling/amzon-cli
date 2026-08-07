// pricing 域共用:batch 请求的响应结构、ID 列表解析、逐项结果映射
// (competitive 与 foep 此前各自平行实现,统一收编于此)

import { AmzError } from '../../internal/errs/errors.js';
import { strFlag } from '../common.js';

export interface BatchResponse {
  responses?: Array<{
    status?: { statusCode?: number; reasonPhrase?: string };
    body?: Record<string, unknown>;
  }>;
}

/** 解析逗号分隔的 ID 列表并校验数量(亚马逊 batch 上限 20)。 */
export function parseIdList(
  flags: Record<string, unknown>,
  key: string,
  flagName: string,
  itemName: string,
): string[] {
  const items = (strFlag(flags, key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0 || items.length > 20) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_batch_list',
      param: flagName,
      hintAgent: 'fix_param',
      hintHuman: `${flagName} 需要 1 到 20 个${itemName}(逗号分隔),当前 ${items.length} 个。`,
      message: `${flagName} must contain 1-20 items, got ${items.length}`,
    });
  }
  return items;
}

/**
 * 按下标把 batch 响应与请求 ID 配对:200 取 body,否则取错误。
 * 一致性校验(防串行错配把 A 的数据安到 B 头上):
 *   - responses 条数必须与请求 ids 条数一致,不一致抛类型化上游错误(整批不可采信);
 *   - 若 body 里带同名标识字段(如 asin),与请求核对,不一致的行标 error 而不是照单收下。
 */
export function mapBatchResults(
  resp: BatchResponse,
  ids: string[],
  idKey: string,
  bodyKey: string,
): Array<Record<string, unknown>> {
  const responses = resp.responses ?? [];
  if (responses.length !== ids.length) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'pricing.batch_count_mismatch',
      hintAgent: 'report_to_human',
      hintHuman:
        `亚马逊批量接口返回了 ${responses.length} 条结果,但本批请求了 ${ids.length} 个,` +
        '无法按顺序一一对应。请不要采信本批结果,稍后重试;若反复出现请联系管理员。',
      message: `batch response count ${responses.length} != request count ${ids.length}; results cannot be paired by index`,
    });
  }
  return responses.map((r, i) => {
    const id = ids[i]!;
    // body 若自带标识(如 competitiveSummary 的 asin),与请求核对;对不上就标错误行
    const bodyId = r.body?.[idKey];
    if (r.status?.statusCode === 200 && typeof bodyId === 'string' && bodyId.toUpperCase() !== id.toUpperCase()) {
      return {
        [idKey]: id,
        httpStatus: r.status?.statusCode,
        error: `response ${idKey} mismatch: expected ${id}, got ${bodyId}(上游返回的标识与请求不一致,已丢弃该行数据)`,
      };
    }
    return {
      [idKey]: id,
      httpStatus: r.status?.statusCode,
      ...(r.status?.statusCode === 200
        ? { [bodyKey]: r.body }
        : { error: r.body ?? r.status?.reasonPhrase }),
    };
  });
}
