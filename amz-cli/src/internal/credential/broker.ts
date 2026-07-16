// Broker 凭证模式(部署阶段,发给同事的版本):
//   向 Token Broker(Zeabur)领取 1 小时 access_token。
//   同事的 .env 只有:BROKER_URL / TEAM_TOKEN / STORE / SP_API_REGION
//   —— 没有任何长期凭证(规格 §5.1)。
//
// mint 协议见 amz-broker/README.md;token 只存进程内存。

import { AmzError } from '../errs/errors.js';
import { SP_API_ENDPOINTS, isSandboxMode, type Region } from '../client/regions.js';
import type { AccessCredentials, CredentialProvider } from './provider.js';

const ADS_API_ENDPOINTS: Record<Region, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};

export interface BrokerConfig {
  brokerUrl: string;
  teamToken: string;
  store: string;
  region: Region;
}

/** 从环境变量读取 broker 配置;BROKER_URL 未设置时返回 null(表示走 local 模式)。 */
export function brokerConfigFromEnv(): BrokerConfig | null {
  const brokerUrl = process.env['BROKER_URL']?.trim();
  if (!brokerUrl) return null;
  if (isSandboxMode()) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'broker.sandbox_not_supported',
      param: 'SP_API_SANDBOX',
      hintAgent: 'report_to_human',
      hintHuman:
        'Broker 模式目前不支持 SP_API_SANDBOX。为防止把沙盒命令误发到生产环境，CLI 已停止执行；请使用本地沙盒凭证或升级 Broker 协议。',
      message: 'SP_API_SANDBOX cannot be combined with BROKER_URL',
    });
  }
  let parsedBrokerUrl: URL;
  try {
    parsedBrokerUrl = new URL(brokerUrl);
  } catch {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'broker.invalid_url',
      param: 'BROKER_URL',
      hintAgent: 'fix_param',
      hintHuman: 'BROKER_URL 不是合法网址，请检查 .env。',
      message: `invalid BROKER_URL: ${brokerUrl}`,
    });
  }
  const localDev = parsedBrokerUrl.hostname === 'localhost' || parsedBrokerUrl.hostname === '127.0.0.1';
  if (parsedBrokerUrl.protocol !== 'https:' && !(localDev && parsedBrokerUrl.protocol === 'http:')) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'broker.https_required',
      param: 'BROKER_URL',
      hintAgent: 'report_to_human',
      hintHuman: 'Broker 必须使用 HTTPS；只有 localhost/127.0.0.1 开发环境允许 HTTP。',
      message: `insecure BROKER_URL protocol: ${parsedBrokerUrl.protocol}`,
    });
  }
  const teamToken = process.env['TEAM_TOKEN']?.trim() ?? '';
  const store = process.env['STORE']?.trim().toUpperCase() ?? '';
  const region = (process.env['SP_API_REGION'] ?? 'na').trim().toLowerCase() as Region;
  if (!teamToken || !store) {
    throw new AmzError({
      type: 'auth_expired',
      subtype: 'broker.config_incomplete',
      hintAgent: 'report_to_human',
      hintHuman: '配置不完整:设置了 BROKER_URL 但缺少 TEAM_TOKEN 或 STORE,请检查 .env。',
      message: 'BROKER_URL is set but TEAM_TOKEN or STORE is missing',
    });
  }
  if (!(region in SP_API_ENDPOINTS)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_region',
      param: 'SP_API_REGION',
      hintAgent: 'fix_param',
      hintHuman: `SP_API_REGION="${region}" 无效,应为 na / eu / fe。`,
      message: `invalid SP_API_REGION: ${region}`,
    });
  }
  return { brokerUrl, teamToken, store, region };
}

/** 向 broker 领 token(SP 或 Ads 通用);region 省略时用配置的默认区域。 */
export async function mintFromBroker(
  cfg: BrokerConfig,
  api: 'sp-api' | 'ads',
  region?: Region,
): Promise<{
  accessToken: string;
  expiresIn: number;
  endpoint: string;
  clientId?: string;
  sellerId?: string;
}> {
  const resp = await fetch(new URL('/token/mint', cfg.brokerUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Team-Token': cfg.teamToken,
    },
    body: JSON.stringify({ store: cfg.store, api, region: region ?? cfg.region }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch((err: unknown) => {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'broker.unreachable',
      hintAgent: 'backoff_and_retry',
      hintHuman: '连不上凭证服务(Token Broker),请检查网络;若持续失败请联系管理员。',
      message: `broker unreachable: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
      cause: err,
    });
  });

  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.status === 401) {
    throw new AmzError({
      type: 'auth_expired',
      subtype: 'broker.team_token_rejected',
      hintAgent: 'report_to_human',
      hintHuman: '你的团队令牌无效或已被吊销,请联系管理员重新发放。',
      message: 'broker rejected team token',
      status: 401,
    });
  }
  if (resp.status === 403) {
    throw new AmzError({
      type: 'insufficient_scope',
      subtype: 'broker.access_forbidden',
      hintAgent: 'report_to_human',
      hintHuman: '你的团队令牌没有该店铺、API 或区域的访问权限，请联系管理员检查 TEAM_ACCESS 策略。',
      message: `broker denied store/api/region access: ${JSON.stringify(body).slice(0, 300)}`,
      status: 403,
    });
  }
  if (!resp.ok || typeof body.access_token !== 'string') {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'broker.mint_failed',
      hintAgent: 'report_to_human',
      hintHuman: `凭证服务返回错误(${String(body.error ?? resp.status)}):${String(body.detail ?? '请联系管理员检查 Broker 配置')}`,
      message: `broker mint failed: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 300)}`,
      status: resp.status,
    });
  }
  const requestedRegion = region ?? cfg.region;
  const expectedEndpoint =
    api === 'ads' ? ADS_API_ENDPOINTS[requestedRegion] : SP_API_ENDPOINTS[requestedRegion];
  const endpoint =
    typeof body.endpoint === 'string' && body.endpoint.trim() !== ''
      ? body.endpoint
      : expectedEndpoint;
  if (endpoint !== expectedEndpoint) {
    throw new AmzError({
      type: 'upstream_error',
      subtype: 'broker.invalid_endpoint',
      hintAgent: 'report_to_human',
      hintHuman: '凭证服务返回了非官方或区域不匹配的 Amazon API 地址，已拒绝发送 access token。请管理员检查 Broker。',
      message: `broker endpoint mismatch for ${api}/${requestedRegion}: ${endpoint}`,
    });
  }
  return {
    accessToken: body.access_token,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    endpoint,
    ...(typeof body.client_id === 'string' ? { clientId: body.client_id } : {}),
    ...(typeof body.seller_id === 'string' && body.seller_id.trim() !== ''
      ? { sellerId: body.seller_id.trim() }
      : {}),
  };
}

export class BrokerCredentialProvider implements CredentialProvider {
  private cache = new Map<Region, { token: string; endpoint: string; expiresAt: number; sellerId?: string }>();

  constructor(private readonly cfg: BrokerConfig) {}

  async getCredentials(region?: Region): Promise<AccessCredentials> {
    const r = region ?? this.cfg.region;
    const cached = this.cache.get(r);
    if (cached && Date.now() < cached.expiresAt) {
      return {
        accessToken: cached.token,
        endpoint: cached.endpoint,
        region: r,
        ...(cached.sellerId ? { sellerId: cached.sellerId } : {}),
      };
    }
    const minted = await mintFromBroker(this.cfg, 'sp-api', r);
    this.cache.set(r, {
      token: minted.accessToken,
      endpoint: minted.endpoint,
      expiresAt: Date.now() + (minted.expiresIn - 60) * 1000,
      ...(minted.sellerId ? { sellerId: minted.sellerId } : {}),
    });
    return {
      accessToken: minted.accessToken,
      endpoint: minted.endpoint,
      region: r,
      ...(minted.sellerId ? { sellerId: minted.sellerId } : {}),
    };
  }
}
