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

/** 按下标把 batch 响应与请求 ID 配对:200 取 body,否则取错误。 */
export function mapBatchResults(
  resp: BatchResponse,
  ids: string[],
  idKey: string,
  bodyKey: string,
): Array<Record<string, unknown>> {
  return (resp.responses ?? []).map((r, i) => ({
    [idKey]: ids[i],
    httpStatus: r.status?.statusCode,
    ...(r.status?.statusCode === 200
      ? { [bodyKey]: r.body }
      : { error: r.body ?? r.status?.reasonPhrase }),
  }));
}
