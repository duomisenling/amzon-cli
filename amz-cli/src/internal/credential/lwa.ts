// LWA refresh_token → access_token 交换(SP-API 与广告 API 共用的唯一实现)
//
// 调用方(credential/local.ts、client/ads-client.ts)只负责:
//   1. 提供各自的凭证三元组
//   2. 把失败结果包装成各自语境的 AmzError(错误文案不同,机制相同)

import { LWA_TOKEN_URL } from '../client/regions.js';

export interface LwaTokenResult {
  ok: true;
  accessToken: string;
  expiresIn: number;
  /** 提前 60 秒视为过期的绝对时间戳,调用方可直接用于缓存 */
  expiresAt: number;
}

export interface LwaTokenFailure {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

/** 用 refresh_token 换 access_token;网络错误原样抛出(由调用方分类包装)。 */
export async function exchangeLwaToken(creds: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<LwaTokenResult | LwaTokenFailure> {
  const resp = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof body.access_token !== 'string') {
    return { ok: false, status: resp.status, body };
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    ok: true,
    accessToken: body.access_token,
    expiresIn,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };
}
