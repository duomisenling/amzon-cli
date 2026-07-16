// Amazon Ads API client(与 SP-API 完全独立的体系)
//
// ⚠️ 本模块是对规格 §7.4(广告走官方 Ads MCP)的授权变更:项目负责人
//    2026-07-13 明确指示在 CLI 中加入广告 API 的读能力。
//
// 与 SP-API 的关键区别(2026-07-13 从官方 api-overview 文档与社区核实):
//   1. 端点不同:NA https://advertising-api.amazon.com
//               (EU advertising-api-eu / FE advertising-api-fe,接入时再核验)
//   2. 凭证不同:LWA refresh token 必须带 advertising::campaign_management scope,
//      SP-API 的 refresh token 没有此 scope,不能混用
//   3. 认证头不同:Amazon-Advertising-API-ClientId + Authorization: Bearer
//      + Amazon-Advertising-API-Scope(profileId,除 /v2/profiles 外都要带)
//
// 凭证环境变量:ADS_CLIENT_ID / ADS_CLIENT_SECRET / ADS_REFRESH_TOKEN /
//   ADS_REGION(默认 na)。未配置时回退尝试 LWA_*(便于验证 SP-API 凭证
//   是否恰好有广告权限——通常没有,会得到明确的 401/403)。

import { AmzError } from '../errs/errors.js';
import { progress } from '../errs/output.js';
import { exchangeLwaToken } from '../credential/lwa.js';
import { brokerConfigFromEnv, mintFromBroker } from '../credential/broker.js';

/** 广告 API v3 的 vendor media type(Accept 与 Content-Type 同值)。 */
export const ADS_CONTENT_TYPES = {
  spCampaign: 'application/vnd.spCampaign.v3+json',
  spAdGroup: 'application/vnd.spAdGroup.v3+json',
  spProductAd: 'application/vnd.spProductAd.v3+json',
  spKeyword: 'application/vnd.spKeyword.v3+json',
  spNegativeKeyword: 'application/vnd.spNegativeKeyword.v3+json',
  spKeywordRecommendation: 'application/vnd.spkeywordsrecommendation.v5+json',
  createReport: 'application/vnd.createasyncreportrequest.v3+json',
} as const;

const ADS_ENDPOINTS = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
} as const;

interface AdsCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  endpoint: string;
}

function resolveAdsCreds(): AdsCreds {
  const clientId = (process.env['ADS_CLIENT_ID'] ?? process.env['LWA_CLIENT_ID'] ?? '').trim();
  const clientSecret = (
    process.env['ADS_CLIENT_SECRET'] ?? process.env['LWA_CLIENT_SECRET'] ?? ''
  ).trim();
  const refreshToken = (
    process.env['ADS_REFRESH_TOKEN'] ?? process.env['LWA_REFRESH_TOKEN'] ?? ''
  ).trim();
  const region = (process.env['ADS_REGION'] ?? 'na').trim().toLowerCase();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new AmzError({
      type: 'auth_expired',
      subtype: 'ads.credentials_missing',
      hintAgent: 'report_to_human',
      hintHuman:
        '缺少广告 API 凭证:请在 .env 配置 ADS_CLIENT_ID / ADS_CLIENT_SECRET / ADS_REFRESH_TOKEN。' +
        '注意:广告 API 需要单独申请准入,refresh token 必须带 advertising::campaign_management 权限,与 SP-API 凭证不通用。',
      message: 'Ads API credentials missing (ADS_* env vars)',
    });
  }
  const endpoint = ADS_ENDPOINTS[region as AdsRegion];
  if (!endpoint) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.invalid_region',
      param: 'ADS_REGION',
      hintAgent: 'fix_param',
      hintHuman: `ADS_REGION="${region}" 无效,应为 na / eu / fe。`,
      message: `invalid ADS_REGION: ${region}`,
    });
  }
  return { clientId, clientSecret, refreshToken, endpoint };
}

interface AdsAuth {
  token: string;
  clientId: string;
  endpoint: string;
}

export type AdsRegion = keyof typeof ADS_ENDPOINTS;

export class AdsClient {
  // 同一套广告凭证全区域通用(2026-07-15 官方核实),端点须按区域选;缓存按区域分 key
  private auth = new Map<string, { value: AdsAuth; expiresAt: number }>();

  /**
   * 取认证三元组(token / clientId 头 / 端点)。
   * 有 BROKER_URL → 向 Token Broker 领(同事版,本机无长期凭证);
   * 否则          → 本机 ADS_* 凭证直接换(开发者模式)。
   */
  private async getAuth(region?: AdsRegion): Promise<AdsAuth> {
    const key = region ?? 'default';
    const cached = this.auth.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    const brokerCfg = brokerConfigFromEnv();
    if (brokerCfg) {
      const minted = await mintFromBroker(brokerCfg, 'ads', region);
      if (!minted.clientId) {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'broker.missing_ads_client_id',
          hintAgent: 'report_to_human',
          hintHuman: '凭证服务没有返回广告应用的 client_id,请管理员检查 Broker 的 ADS_CLIENT_ID 配置。',
          message: 'broker mint(ads) returned no client_id',
        });
      }
      const value: AdsAuth = {
        token: minted.accessToken,
        clientId: minted.clientId,
        endpoint: minted.endpoint,
      };
      this.auth.set(key, { value, expiresAt: Date.now() + (minted.expiresIn - 60) * 1000 });
      return value;
    }

    const c = resolveAdsCreds();
    const result = await exchangeLwaToken(c);
    if (!result.ok) {
      throw new AmzError({
        type: 'auth_expired',
        subtype: 'ads.token_exchange_failed',
        hintAgent: 'reauthorize',
        hintHuman:
          '广告 API 换取令牌失败。最常见原因:当前 refresh token 没有广告权限' +
          '(advertising::campaign_management)——广告 API 需要单独申请准入并重新授权。',
        message: `Ads LWA exchange failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
        status: result.status,
      });
    }
    const endpoint = region ? ADS_ENDPOINTS[region] : c.endpoint;
    const value: AdsAuth = { token: result.accessToken, clientId: c.clientId, endpoint };
    this.auth.set(key, { value, expiresAt: result.expiresAt });
    return value;
  }

  /**
   * 调用 Ads API。profileId 为空时不带 Scope 头(仅 /v2/profiles 这类账户级接口)。
   * contentType 用于 v3 接口的 vendor media type(如 application/vnd.spCampaign.v3+json)。
   */
  async request(
    method: string,
    path: string,
    opts: {
      profileId?: string;
      body?: unknown;
      contentType?: string;
      extraHeaders?: Record<string, string>;
      /** 广告区域端点(同一凭证全区域通用,只切端点);省略用 ADS_REGION 默认 */
      region?: AdsRegion;
      /** 明确声明该请求在服务端 5xx 后重复发送不会产生重复写入。默认仅 GET/HEAD。 */
      retry5xx?: boolean;
    } = {},
  ): Promise<unknown> {
    const auth = await this.getAuth(opts.region);
    const replaySafe =
      method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' || opts.retry5xx === true;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        'Amazon-Advertising-API-ClientId': auth.clientId,
        Authorization: `Bearer ${auth.token}`,
        ...(opts.extraHeaders ?? {}),
      };
      if (opts.profileId) headers['Amazon-Advertising-API-Scope'] = opts.profileId;
      if (opts.contentType) {
        headers['Content-Type'] = opts.contentType;
        headers['Accept'] = opts.contentType;
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const resp = await fetch(new URL(path, auth.endpoint), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      }).catch((err: unknown) => {
        if (!replaySafe) {
          throw new AmzError({
            type: 'upstream_error',
            subtype: 'ads.write_result_unknown',
            hintAgent: 'report_to_human',
            hintHuman:
              `广告 ${method.toUpperCase()} 写请求发生网络中断或超时，无法判断 Amazon Ads 是否已经执行。` +
              '不要自动重试；请先查询广告后台或使用只读命令核对结果。',
            message: `Ads ${method.toUpperCase()} ${path} failed after dispatch; write result is ambiguous: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'ads.network_error',
          hintAgent: 'backoff_and_retry',
          hintHuman: '连不上亚马逊广告接口,请检查网络后重试。',
          message: `Ads API request failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        });
      });

      if (resp.ok) {
        if (resp.status === 204) return null;
        const text = await resp.text();
        if (text.trim() === '') return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          if (!replaySafe) {
            throw new AmzError({
              type: 'upstream_error',
              subtype: 'ads.write_result_unknown',
              hintAgent: 'report_to_human',
              hintHuman:
                `Amazon Ads 已接受 ${method.toUpperCase()} 写请求并返回 HTTP ${resp.status}，但响应内容无法解析。` +
                '写入结果可能已经生效；不要重试，请先查询广告后台核对。',
              message: `Ads ${method.toUpperCase()} ${path} returned HTTP ${resp.status} with invalid JSON; write result is ambiguous: ${text.slice(0, 300)}`,
              status: resp.status,
            });
          }
          throw new AmzError({
            type: 'upstream_error',
            subtype: 'ads.invalid_json_response',
            hintAgent: 'backoff_and_retry',
            hintHuman: '广告接口返回了无法解析的成功响应，可能是网关或网络异常，请稍后重试。',
            message: `Ads API HTTP ${resp.status} on ${path} returned invalid JSON (${resp.headers.get('content-type') ?? 'unknown content-type'}): ${text.slice(0, 300)}`,
            status: resp.status,
            retryable: true,
          });
        }
      }

      const text = await resp.text().catch(() => '');
      const retryable5xx =
        resp.status >= 500 &&
        replaySafe;
      if ((resp.status === 429 || retryable5xx) && attempt < 3) {
        const backoffMs = Math.min(2 ** attempt * 1000 + Math.random() * 500, 15_000);
        progress(`· 广告接口返回 ${resp.status},${Math.round(backoffMs / 1000)}s 后重试...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        throw new AmzError({
          type: 'insufficient_scope',
          subtype: 'ads.access_denied',
          hintAgent: 'report_to_human',
          hintHuman:
            `广告 API 拒绝访问(HTTP ${resp.status})。最常见原因:此 LWA 应用没有广告 API 准入,` +
            '或 refresh token 缺少 advertising::campaign_management 权限。需要在 Amazon Ads 控制台单独申请。',
          message: `Ads API HTTP ${resp.status} on ${path}: ${text.slice(0, 800)}`,
          status: resp.status,
        });
      }
      if (resp.status >= 500 && !retryable5xx) {
        throw new AmzError({
          type: 'upstream_error',
          subtype: 'ads.write_result_unknown',
          hintAgent: 'report_to_human',
          hintHuman:
            `广告接口在 ${method.toUpperCase()} 写请求后返回 HTTP ${resp.status}，结果可能已生效。` +
            'CLI 没有自动重试；请先查询广告后台核对，避免重复创建或重复修改。',
          message: `Ads ${method.toUpperCase()} ${path} returned HTTP ${resp.status}; ambiguous write result, not replayed: ${text.slice(0, 800)}`,
          status: resp.status,
        });
      }
      throw new AmzError({
        type: resp.status === 429 ? 'rate_limited' : 'upstream_error',
        subtype: resp.status === 429 ? 'ads.throttled' : 'ads.error',
        hintAgent: resp.status === 429 ? 'backoff_and_retry' : 'report_to_human',
        hintHuman:
          resp.status === 429
            ? '广告接口繁忙,已自动重试仍失败,请稍后再试。'
            : `广告接口调用失败(HTTP ${resp.status}),请检查参数或稍后重试。`,
        message: `Ads API HTTP ${resp.status} on ${path}: ${text.slice(0, 800)}`,
        status: resp.status,
        retryable: resp.status === 429 || resp.status >= 500,
      });
    }
  }
}
