// SP-API HTTP client(设计决策 1:自封轻量 fetch + bottleneck 限流)
//
// 职责:
//   1. 注入 x-amz-access-token(2023-10 起 SP-API 不再要求 AWS SigV4 签名,
//      已用真实凭证实测验证 —— 见 scripts/hello.mjs)
//   2. 限流:bottleneck 控制请求节奏,从源头减少 429
//   3. 429 / 5xx 指数退避重试(规格 §6.3 强制要求);读请求(GET/HEAD/显式 retry5xx)
//      的网络错误同样退避重试,写请求网络错误"结果未知,不得重放",一次即抛
//   4. 把 HTTP 错误分类成类型化 AmzError,业务代码不接触裸 HTTP 错误

import Bottleneck from 'bottleneck';
import { AmzError } from '../errs/errors.js';
import { auditLog } from '../audit.js';
import { spApiUserAgent } from '../user-agent.js';
import { amazonFetch, type EgressResponse } from '../net/egress.js';
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
    const replaySafe =
      method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' || opts.retry5xx === true;
    for (let attempt = 0; ; attempt++) {
      let resp: EgressResponse;
      try {
        resp = await limiter.schedule(() => this.doFetch(method, path, opts, replaySafe));
      } catch (err) {
        // 读请求(replaySafe)的可重试网络错误(sp_api.network_error)进指数退避重试,
        // 与 429/5xx 共用同一个 attempt 计数和上限。写请求的"结果未知"与 egress 的
        // 代理配置错误都不带 retryable,保持一次即抛。重试期间不记审计失败行,
        // 只在最终失败时记一条,避免同一次调用刷出多条失败底账。
        if (replaySafe && err instanceof AmzError && err.retryable && attempt < MAX_RETRIES) {
          const backoffMs = Math.min(2 ** attempt * 1000 + Math.random() * 500, 30_000);
          progress(
            `· 网络错误,${Math.round(backoffMs / 1000)}s 后自动重试(第 ${attempt + 1}/${MAX_RETRIES} 次)...`,
          );
          await sleep(backoffMs);
          continue;
        }
        auditLog({
          api: 'sp', method, path, region: opts.region, ok: false,
          errorSubtype: err instanceof AmzError ? err.subtype : 'network_error',
        });
        throw err;
      }

      // 成功
      if (resp.ok) {
        if (resp.status === 204) {
          auditLog({ api: 'sp', method, path, region: opts.region, status: resp.status, ok: true });
          return null;
        }
        // 2xx 状态行已收到,但响应体可能还在路上:读 body 时超时/连接中断对写请求
        // 同样意味着"结果未知,不得重试"。成功审计必须等 body 读完才记,否则会留下
        // ok:true 却实际抛错的矛盾底账。
        let text: string;
        try {
          text = await resp.text();
        } catch (err) {
          const classified = !replaySafe
            ? new AmzError({
                type: 'upstream_error',
                subtype: 'sp_api.write_result_unknown',
                hintAgent: 'report_to_human',
                hintHuman:
                  `Amazon 已对 ${method.toUpperCase()} 写请求返回 HTTP ${resp.status}，但读取响应内容时网络中断。` +
                  '写入结果可能已经生效；不要重试，请先用只读查询或 Seller Central 核对。',
                message: `${method.toUpperCase()} ${path} returned HTTP ${resp.status} but reading the body failed; write result is ambiguous: ${err instanceof Error ? err.message : String(err)}`,
                status: resp.status,
                cause: err,
              })
            : new AmzError({
                type: 'upstream_error',
                subtype: 'sp_api.network_error',
                hintAgent: 'backoff_and_retry',
                hintHuman: '读取亚马逊响应时网络中断,请稍后重试。',
                message: `reading response body of ${path} failed after HTTP ${resp.status}: ${err instanceof Error ? err.message : String(err)}`,
                status: resp.status,
                retryable: true,
                cause: err,
              });
          auditLog({
            api: 'sp', method, path, region: opts.region, status: resp.status, ok: false,
            errorSubtype: classified.subtype,
          });
          throw classified;
        }
        auditLog({ api: 'sp', method, path, region: opts.region, status: resp.status, ok: true });
        if (text.trim() === '') return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          if (!replaySafe) {
            throw new AmzError({
              type: 'upstream_error',
              subtype: 'sp_api.write_result_unknown',
              hintAgent: 'report_to_human',
              hintHuman:
                `Amazon 已接受 ${method.toUpperCase()} 写请求并返回 HTTP ${resp.status}，但响应内容无法解析。` +
                '写入结果可能已经生效；不要重试，请先用只读查询或 Seller Central 核对。',
              message: `${method.toUpperCase()} ${path} returned HTTP ${resp.status} with invalid JSON; write result is ambiguous: ${text.slice(0, 300)}`,
              status: resp.status,
            });
          }
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
        replaySafe;
      if ((resp.status === 429 || retryable5xx) && attempt < MAX_RETRIES) {
        // retry-after 来自上游,不能无条件照办:返回 3600 会让命令静默睡 1 小时,
        // 用户只会看到"卡住"。cap 到 60 秒,超过就按 60 秒等。
        const retryAfterHeader = Number(resp.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? Math.min(retryAfterHeader * 1000, 60_000)
          : Math.min(2 ** attempt * 1000 + Math.random() * 500, 30_000);
        progress(
          `· 亚马逊返回 ${resp.status},${Math.round(backoffMs / 1000)}s 后自动重试(第 ${attempt + 1}/${MAX_RETRIES} 次)...`,
        );
        await sleep(backoffMs);
        continue;
      }

      const classified = this.classifyError(resp.status, bodyText, path, method, retryable5xx);
      auditLog({
        api: 'sp', method, path, region: opts.region, status: resp.status, ok: false,
        errorSubtype: classified.subtype,
      });
      throw classified;
    }
  }

  private async doFetch(
    method: string,
    path: string,
    opts: RequestOptions,
    replaySafe: boolean,
  ): Promise<EgressResponse> {
    const creds = await this.credentials.getCredentials(opts.region);
    const url = new URL(path, creds.endpoint);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      'x-amz-access-token': creds.accessToken,
      // 按账号可配的 User-Agent,填各自应用注册的名字与版本(见 user-agent.ts)
      'User-Agent': spApiUserAgent(),
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    // 按账号配置的代理发出(未配置 SP_API_PROXY 时等同于直连,见 net/egress.ts)
    return amazonFetch(
      url,
      { method, headers, body, signal: AbortSignal.timeout(60_000) },
      'sp',
    ).catch((err: unknown) => {
      // 代理配置错误(URL 非法/协议不支持)在发出任何字节之前就抛出,是 AmzError。
      // 必须原样上抛:包装成 write_result_unknown 会误导用户去核对一次根本没发出的写入。
      if (err instanceof AmzError) throw err;
      if (!replaySafe) {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'sp_api.write_result_unknown',
          hintAgent: 'report_to_human',
          hintHuman:
            `${method.toUpperCase()} 写请求发生网络中断或超时，无法判断 Amazon 是否已经执行。` +
            '不要自动重试；请先用只读查询或 Seller Central 核对结果。',
          message: `${method.toUpperCase()} request to ${path} failed after dispatch; write result is ambiguous: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
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
