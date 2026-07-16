// amz-broker —— Token Broker(规格 §5.2)
//
// 职责仅限于换取 token,不代理业务请求:
//   CLI 带团队令牌 → 校验白名单 → 查对应店铺的 refresh_token(环境变量)
//   → 向 LWA 换 1 小时 access_token → 返回给 CLI(CLI 直连亚马逊)
//
// 零依赖:只用 Node 20+ 内置模块,单文件,无构建步骤。
//
// ── 环境变量约定(全部在 Zeabur 控制台配置,绝不写进代码/仓库)──
//   PORT                     监听端口(Zeabur 自动注入,默认 8080)
//   TEAM_TOKENS              团队令牌白名单:"名字1:令牌1,名字2:令牌2"
//                            名字用于审计日志;删掉某人的条目=立即吊销
//   TEAM_ACCESS              JSON 店铺权限策略。每个成员必须显式声明 stores/apis/regions；
//                            例:{"member_a":{"stores":["SHOP_A"],"apis":["sp-api"],"regions":["na"]}}
//   LWA_CLIENT_ID            SP-API 应用凭证(全店铺共用)
//   LWA_CLIENT_SECRET
//   RT_SP_<店铺>_<区域>       各店铺 SP refresh_token,区域 NA/EU/FE
//                            例:RT_SP_SHOP_A_NA=Atzr|xxx
//   SELLER_ID_<店铺>_<区域>   各店铺、区域的 Seller ID（Listing 命令需要）
//                            例:SELLER_ID_SHOP_A_NA=A1EXAMPLE
//   ADS_CLIENT_ID            广告应用凭证(可与 LWA_* 相同,分开配置)
//   ADS_CLIENT_SECRET
//   RT_ADS_<店铺>            各店铺广告 refresh_token(广告无区域之分,LWA 通用)
//                            例:RT_ADS_SHOP_A=Atzr|yyy
//
// ── 接口 ──
//   GET  /health        存活检查(不需要令牌)
//   POST /token/mint    Headers: X-Team-Token: <团队令牌>
//                       Body: {store:"SHOP_A", api:"sp-api"|"ads",
//                              region:"na"|"eu"|"fe"(或 marketplace:"US" 等价)}
//                       → {access_token, expires_in, endpoint[, client_id]}
//
// ── 审计(规格 §9,留存 ≥90 天)──
//   每次 mint 输出一行 JSON 到 stdout(Zeabur 日志);字段:时间/请求人/店铺/
//   api/区域/结果。注意确认 Zeabur 日志保留期,不足 90 天需外接日志服务。

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { parseMintApi, readRequestBody } from './protocol.mjs';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

const SP_ENDPOINTS = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};
const ADS_ENDPOINTS = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};
// marketplace 国家码 → 区域(与 CLI 的 regions.ts 一致,官方文档核实)
const COUNTRY_TO_REGION = {
  US: 'na', CA: 'na', MX: 'na', BR: 'na',
  UK: 'eu', GB: 'eu', DE: 'eu', FR: 'eu', IT: 'eu', ES: 'eu',
  JP: 'fe', AU: 'fe', SG: 'fe',
};

/** 解析 TEAM_TOKENS 白名单:"alice:tok1,bob:tok2" → [{name, token}] */
function parseTeamTokens() {
  return (process.env.TEAM_TOKENS ?? '')
    .split(',')
    .map((pair) => {
      const i = pair.indexOf(':');
      return i > 0
        ? { name: pair.slice(0, i).trim(), token: pair.slice(i + 1).trim() }
        : null;
    })
    .filter((x) => x && x.name && x.token);
}

/** 恒定时间比较,防时序攻击;返回命中的成员名或 null。 */
function authenticate(teamToken) {
  if (!teamToken) return null;
  const given = Buffer.from(String(teamToken));
  for (const entry of parseTeamTokens()) {
    const expect = Buffer.from(entry.token);
    if (given.length === expect.length && timingSafeEqual(given, expect)) {
      return entry.name;
    }
  }
  return null;
}

/** 默认拒绝：成员必须在 TEAM_ACCESS 中显式获准目标店铺/API/区域。数组可用 "*"。 */
function authorize(member, { store, api, region }) {
  let policies;
  try {
    policies = JSON.parse(process.env.TEAM_ACCESS ?? '{}');
  } catch {
    return { ok: false, reason: 'invalid_team_access_json' };
  }
  const policy = policies?.[member];
  if (!policy || typeof policy !== 'object') return { ok: false, reason: 'member_policy_missing' };
  const allows = (values, value) =>
    Array.isArray(values) && (values.includes('*') || values.map((x) => String(x).toLowerCase()).includes(value.toLowerCase()));
  if (!allows(policy.stores, store)) return { ok: false, reason: 'store_forbidden' };
  if (!allows(policy.apis, api)) return { ok: false, reason: 'api_forbidden' };
  if (!allows(policy.regions, region)) return { ok: false, reason: 'region_forbidden' };
  return { ok: true };
}

/** 审计日志:一行 JSON 到 stdout。 */
function audit(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'audit', ...fields }));
}

// 进程内 token 缓存(提前 120s 视为过期),key = api:store:region
const tokenCache = new Map();

async function mintToken({ store, api, region }) {
  const cacheKey = `${api}:${store}:${region}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.payload, cached: true };
  }

  let refreshToken, clientId, clientSecret, endpoint, extra = {};
  if (api === 'sp-api') {
    refreshToken = process.env[`RT_SP_${store}_${region.toUpperCase()}`];
    clientId = process.env.LWA_CLIENT_ID;
    clientSecret = process.env.LWA_CLIENT_SECRET;
    endpoint = SP_ENDPOINTS[region];
    const sellerId = process.env[`SELLER_ID_${store}_${region.toUpperCase()}`]?.trim();
    if (sellerId) extra = { seller_id: sellerId };
  } else {
    refreshToken = process.env[`RT_ADS_${store}`];
    clientId = process.env.ADS_CLIENT_ID;
    clientSecret = process.env.ADS_CLIENT_SECRET;
    endpoint = ADS_ENDPOINTS[region] ?? ADS_ENDPOINTS.na;
    // 广告调用需要 ClientId 头;client_id 是公开标识符,可下发
    extra = { client_id: clientId };
  }

  if (!refreshToken) {
    const envName = api === 'sp-api' ? `RT_SP_${store}_${region.toUpperCase()}` : `RT_ADS_${store}`;
    return { error: 'store_not_configured', detail: `环境变量 ${envName} 未配置`, status: 404 };
  }
  if (!clientId || !clientSecret) {
    return { error: 'app_credentials_missing', detail: 'LWA/ADS 应用凭证未配置', status: 500 };
  }

  const resp = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || typeof body.access_token !== 'string') {
    return {
      error: 'lwa_exchange_failed',
      detail: `LWA HTTP ${resp.status}(refresh token 可能已失效,需要重新授权)`,
      status: 502,
    };
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  const payload = { access_token: body.access_token, expires_in: expiresIn, endpoint, ...extra };
  tokenCache.set(cacheKey, { payload, expiresAt: Date.now() + (expiresIn - 120) * 1000 });
  return payload;
}

function json(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/token/mint') {
      const member = authenticate(req.headers['x-team-token']);
      if (!member) {
        audit({ event: 'mint_denied', reason: 'bad_team_token' });
        return json(res, 401, { error: 'unauthorized', detail: '团队令牌无效或已被吊销' });
      }

      let body = '';
      try {
        body = await readRequestBody(req);
      } catch (error) {
        if (error?.code === 'BODY_TOO_LARGE') {
          audit({ event: 'mint_denied', member, reason: 'body_too_large' });
          return json(res, 413, { error: 'body_too_large' });
        }
        throw error;
      }
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }

      const store = String(parsed.store ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
      const api = parseMintApi(parsed.api);
      // region 直接给,或从 marketplace 国家码映射(与规格 §5.2 的 body 等价)
      let region = String(parsed.region ?? '').toLowerCase();
      if (!region && parsed.marketplace) {
        region = COUNTRY_TO_REGION[String(parsed.marketplace).toUpperCase()] ?? '';
      }
      if (!region) region = 'na';

      if (!store) return json(res, 400, { error: 'missing_store' });
      if (!api) return json(res, 400, { error: 'invalid_api', detail: String(parsed.api ?? '') });
      if (!SP_ENDPOINTS[region]) return json(res, 400, { error: 'invalid_region', detail: region });

      const authorization = authorize(member, { store, api, region });
      if (!authorization.ok) {
        audit({ event: 'mint_denied', member, store, api, region, reason: authorization.reason });
        return json(res, 403, { error: 'forbidden', detail: '该成员没有此店铺/API/区域的凭证权限' });
      }

      const result = await mintToken({ store, api, region });
      const ok = !result.error;
      audit({ event: 'mint', member, store, api, region, ok, ...(ok ? {} : { error: result.error }) });

      if (!ok) return json(res, result.status ?? 500, { error: result.error, detail: result.detail });
      return json(res, 200, result);
    }

    json(res, 404, { error: 'not_found' });
  } catch (err) {
    audit({ event: 'server_error', message: err?.message });
    json(res, 500, { error: 'internal_error' });
  }
});

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`PORT must be an integer in [1,65535], got: ${process.env.PORT ?? ''}`);
}
server.listen(port, () => {
  audit({ event: 'startup', port, team_members: parseTeamTokens().map((t) => t.name) });
});
