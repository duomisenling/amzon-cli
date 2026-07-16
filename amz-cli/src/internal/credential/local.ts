// Local 凭证模式(开发阶段):.env 里的 LWA 凭证 → 换 access_token(进程内缓存)
//
// 多区域支持:refresh token 是亚马逊**按区域签发**的——同一账号在开发者中心
// 对 NA / EU 各授权一次,得到两个不同的 token。环境变量约定:
//   LWA_REFRESH_TOKEN_NA / LWA_REFRESH_TOKEN_EU / LWA_REFRESH_TOKEN_FE
//   LWA_REFRESH_TOKEN(兼容旧配置)= 默认区域(SP_API_REGION,默认 na)的 token
// 查询命令按 --marketplace 自动路由区域;该区域没配 token 时给明确中文报错。
//
// 注意:此模式只应在开发者本机使用。发给运营同事的版本必须走 broker 模式
// (同事电脑上永远不能出现 refresh_token —— 规格 §5.1)。

import { AmzError } from '../errs/errors.js';
import {
  SP_API_ENDPOINTS,
  SP_API_SANDBOX_ENDPOINTS,
  isSandboxMode,
  type Region,
} from '../client/regions.js';
import { exchangeLwaToken } from './lwa.js';
import type { AccessCredentials, CredentialProvider } from './provider.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export class LocalCredentialProvider implements CredentialProvider {
  private cache = new Map<Region, CachedToken>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    /** 各区域的 refresh token(至少一个区域) */
    private readonly refreshTokens: Partial<Record<Region, string>>,
    private readonly defaultRegion: Region,
  ) {}

  /** 从环境变量构造;缺失时抛类型化错误。 */
  static fromEnv(): LocalCredentialProvider {
    const need = (name: string): string => {
      const v = process.env[name];
      if (!v || !v.trim()) {
        throw new AmzError({
          type: 'auth_expired',
          subtype: 'credentials_missing',
          hintAgent: 'report_to_human',
          hintHuman: `缺少凭证配置 ${name}。请复制 .env.example 为 .env 并填写(参考 README)。`,
          message: `environment variable ${name} is not set`,
        });
      }
      return v.trim();
    };
    const defaultRegion = (process.env['SP_API_REGION'] || 'na').trim().toLowerCase() as Region;
    if (!(defaultRegion in SP_API_ENDPOINTS)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_region',
        param: 'SP_API_REGION',
        hintAgent: 'fix_param',
        hintHuman: `SP_API_REGION="${defaultRegion}" 无效,应为 na / eu / fe 之一。`,
        message: `invalid SP_API_REGION: ${defaultRegion}`,
      });
    }

    // 收集各区域 token:带后缀的优先;不带后缀的旧写法归入默认区域
    const refreshTokens: Partial<Record<Region, string>> = {};
    for (const region of ['na', 'eu', 'fe'] as Region[]) {
      const v = process.env[`LWA_REFRESH_TOKEN_${region.toUpperCase()}`]?.trim();
      if (v) refreshTokens[region] = v;
    }
    const legacy = process.env['LWA_REFRESH_TOKEN']?.trim();
    if (legacy && !refreshTokens[defaultRegion]) refreshTokens[defaultRegion] = legacy;

    if (Object.keys(refreshTokens).length === 0) {
      throw new AmzError({
        type: 'auth_expired',
        subtype: 'credentials_missing',
        hintAgent: 'report_to_human',
        hintHuman:
          '没有配置任何区域的 refresh token。请在 .env 填写 LWA_REFRESH_TOKEN(默认区域)' +
          '或 LWA_REFRESH_TOKEN_NA / _EU / _FE(多区域)。',
        message: 'no LWA refresh token configured for any region',
      });
    }

    return new LocalCredentialProvider(
      need('LWA_CLIENT_ID'),
      need('LWA_CLIENT_SECRET'),
      refreshTokens,
      defaultRegion,
    );
  }

  async getCredentials(region?: Region): Promise<AccessCredentials> {
    const r = region ?? this.defaultRegion;

    const cached = this.cache.get(r);
    if (cached && Date.now() < cached.expiresAt) {
      return this.toCredentials(cached.accessToken, r);
    }

    const refreshToken = this.refreshTokens[r];
    if (!refreshToken) {
      const configured = Object.keys(this.refreshTokens).join('/').toUpperCase();
      throw new AmzError({
        type: 'auth_expired',
        subtype: 'region_not_authorized',
        hintAgent: 'report_to_human',
        hintHuman:
          `还没有配置 ${r.toUpperCase()} 区域的凭证(当前已配:${configured})。` +
          `需要在开发者中心对该区域的账号授权,拿到 refresh token 后填入 .env 的 LWA_REFRESH_TOKEN_${r.toUpperCase()}。`,
        message: `no refresh token configured for region ${r} (configured: ${configured})`,
      });
    }

    const result = await exchangeLwaToken({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken,
    }).catch((err: unknown) => {
      throw new AmzError({
        type: 'upstream_error',
        subtype: 'lwa.network_error',
        hintAgent: 'backoff_and_retry',
        hintHuman: '连不上亚马逊登录服务(LWA),请检查网络后重试。',
        message: `LWA request failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        cause: err,
      });
    });

    if (!result.ok) {
      throw new AmzError({
        type: 'auth_expired',
        subtype: 'lwa.token_exchange_failed',
        hintAgent: 'reauthorize',
        hintHuman: `亚马逊授权已失效或凭证填写有误(${r.toUpperCase()} 区域),请联系管理员重新授权。`,
        message: `LWA token exchange failed for region ${r}: HTTP ${result.status} ${JSON.stringify(result.body)}`,
        status: result.status,
      });
    }

    this.cache.set(r, { accessToken: result.accessToken, expiresAt: result.expiresAt });
    return this.toCredentials(result.accessToken, r);
  }

  private toCredentials(accessToken: string, region: Region): AccessCredentials {
    const endpoints = isSandboxMode() ? SP_API_SANDBOX_ENDPOINTS : SP_API_ENDPOINTS;
    return { accessToken, endpoint: endpoints[region], region };
  }
}
