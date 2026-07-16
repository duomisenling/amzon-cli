// SP-API HTTP client(设计决策 1:自封轻量 fetch + bottleneck 限流)
//
// 职责:
//   1. 注入 x-amz-access-token(2023-10 起 SP-API 不再要求 AWS SigV4 签名,
//      已用真实凭证实测验证 —— 见 scripts/hello.mjs)
//   2. 限流:bottleneck 控制请求节奏,从源头减少 429
//   3. 429 / 5xx 指数退避重试(规格 §6.3 强制要求)
//   4. 把 HTTP 错误分类成类型化 AmzError,业务代码不接触裸 HTTP 错误

import Bottleneck from 'bottleneck';
import { AmzError } from '../errs/errors.js';
import { progress } from '../errs/output.js';
import type { CredentialProvider } from '../credential/provider.js';
import type { Region } from './regions.js';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 目标区域(按 --marketplace 路由);省略时用默认区域(SP_API_REGION) */
  region?: Region;
  /** 明确声明该请求在服务端 5xx 后重复发送不会产生重复写入。默认仅 GET/HEAD。 */
  retry5xx?: boolean;
}

// SP-API 各接口速率不同(0.5~5 req/s 不等)。这里取保守的全局默认:
// 每 350ms 一个请求、并发 1。后续可按接口细分(ToolDefinition 里声明速率)。
const limiter = new Bottleneck({ minTime: 350, maxConcurrent: 1 });

const MAX_RETRIES = 4;

export class SpApiClient {
  constructor(private readonly credentials: CredentialProvider) {}

  /** 返回当前凭证绑定店铺在指定区域的 Seller ID（Broker 模式使用）。 */
  async getSellerId(region?: Region): Promise<string | undefined> {
    return (await this.credentials.getCredentials(region)).sellerId;
  }

  async get(path: string, query?: RequestOptions['query'], region?: Region): Promise<unknown> {
    return this.request('GET', path, { query, region });
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const resp = await limiter.schedule(() => this.doFetch(method, path, opts));

      // 成功
      if (resp.ok) {
        if (resp.status === 204) return null;
        const text = await resp.text();
        if (text.trim() === '') return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new AmzError({
            type: 'upstream_error',
            subtype: 'sp_api.invalid_json_response',
            hintAgent: 'backoff_and_retry',
            hintHuman: '亚马逊返回了无法解析的成功响应，可能是网关或网络异常，请稍后重试。',
            message: `HTTP ${resp.status} on ${path} returned invalid JSON (${resp.headers.get('content-type') ?? 'unknown content-type'}): ${text.slice(0, 300)}`,
            status: resp.status,
            retryable: true,
          });
        }
      }

      const bodyText = await resp.text().catch(() => '');

      // 429 表示请求未被接受，可安全重试。写请求遇到 5xx 时结果可能未知，
      // 默认不能重放；仅 GET/HEAD 和调用方明确标记安全的读式 POST 可以重试。
      const retryable5xx =
        resp.status >= 500 &&
        (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' || opts.retry5xx === true);
      if ((resp.status === 429 || retryable5xx) && attempt < MAX_RETRIES) {
        const retryAfterHeader = Number(resp.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(2 ** attempt * 1000 + Math.random() * 500, 30_000);
        progress(
          `· 亚马逊返回 ${resp.status},${Math.round(backoffMs / 1000)}s 后自动重试(第 ${attempt + 1}/${MAX_RETRIES} 次)...`,
        );
        await sleep(backoffMs);
        continue;
      }

      throw this.classifyError(resp.status, bodyText, path, method, retryable5xx);
    }
  }

  private async doFetch(method: string, path: string, opts: RequestOptions): Promise<Response> {
    const creds = await this.credentials.getCredentials(opts.region);
    const url = new URL(path, creds.endpoint);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { 'x-amz-access-token': creds.accessToken };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(60_000) }).catch((err: unknown) => {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'sp_api.network_error',
        hintAgent: 'backoff_and_retry',
        hintHuman: '连不上亚马逊接口服务,请检查网络后重试。',
        message: `request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        cause: err,
      });
    });
  }

  /** 把 HTTP 错误状态分类成类型化错误(重试已在上层耗尽)。 */
  private classifyError(
    status: number,
    bodyText: string,
    path: string,
    method: string,
    retryable5xx: boolean,
  ): AmzError {
    const detail = bodyText.slice(0, 2000);
    if (status === 401) {
      return new AmzError({
        type: 'auth_expired',
        subtype: 'sp_api.unauthorized',
        hintAgent: 'reauthorize',
        hintHuman: '亚马逊授权已过期,请联系管理员重新授权。',
        message: `HTTP 401 on ${path}: ${detail}`,
        status,
      });
    }
    if (status === 403) {
      return new AmzError({
        type: 'insufficient_scope',
        subtype: 'sp_api.forbidden',
        hintAgent: 'report_to_human',
        hintHuman: '当前凭证没有这个操作的权限(角色不足或店铺未授权),请联系管理员检查应用角色配置。',
        message: `HTTP 403 on ${path}: ${detail}`,
        status,
      });
    }
    if (status === 404) {
      return new AmzError({
        type: 'invalid_param',
        subtype: 'sp_api.not_found',
        hintAgent: 'fix_param',
        hintHuman: '没有找到对应的数据,请检查输入的 ASIN/SKU/编号是否正确。',
        message: `HTTP 404 on ${path}: ${detail}`,
        status,
      });
    }
    if (status === 429) {
      return new AmzError({
        type: 'rate_limited',
        subtype: 'sp_api.throttled',
        hintAgent: 'backoff_and_retry',
        hintHuman: '亚马逊接口繁忙(已自动重试多次仍失败),请过几分钟再试。',
        message: `HTTP 429 on ${path} after ${MAX_RETRIES} retries: ${detail}`,
        status,
        retryable: true,
      });
    }
    if (status >= 500) {
      if (!retryable5xx) {
        return new AmzError({
          type: 'upstream_error',
          subtype: 'sp_api.write_result_unknown',
          hintAgent: 'report_to_human',
          hintHuman:
            `亚马逊在 ${method.toUpperCase()} 写请求后返回 HTTP ${status}，结果可能已生效。` +
            '为防重复写入，CLI 没有自动重试；请先到后台或用只读查询核对结果，确认未生效后再决定是否重新执行。',
          message: `${method.toUpperCase()} ${path} returned HTTP ${status}; result is ambiguous and request was not replayed: ${detail}`,
          status,
        });
      }
      return new AmzError({
        type: 'upstream_error',
        subtype: 'sp_api.server_error',
        hintAgent: 'backoff_and_retry',
        hintHuman: '亚马逊服务端出错(已自动重试仍失败),请稍后再试。',
        message: `HTTP ${status} on ${path} after retries: ${detail}`,
        status,
        retryable: true,
      });
    }
    return new AmzError({
      type: 'invalid_param',
      subtype: 'sp_api.bad_request',
      hintAgent: 'fix_param',
      hintHuman: '请求参数有误,亚马逊拒绝了这次调用。请检查输入参数。',
      message: `HTTP ${status} on ${path}: ${detail}`,
      status,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
