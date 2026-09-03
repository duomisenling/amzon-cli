// amz-broker —— Token Broker(规格 §5.2)
//
// 职责仅限于换取 token,不代理业务请求:
//   CLI 带团队令牌 → 校验白名单 → 查对应店铺的 refresh_token(环境变量)
//   → 向 LWA 换 1 小时 access_token → 返回给 CLI(CLI 直连亚马逊)
//
// 单文件,无构建步骤,只依赖 undici(为了按店铺走出口代理,见下面的"出口代理"一节)。
//
// ── 环境变量约定(全部在部署平台控制台配置,绝不写进代码/仓库)──
//   PORT                     监听端口(平台自动注入,默认 8080)
//   TEAM_TOKENS              团队令牌白名单:"名字1:令牌1,名字2:令牌2"
//                            名字用于审计日志;删掉某人的条目=立即吊销
//   TEAM_ACCESS              JSON 店铺权限策略。每个成员必须显式声明 stores/apis/regions；
//                            例:{"member_a":{"stores":["SHOP_A"],"apis":["sp-api"],"regions":["na"]}}
//   LWA_CLIENT_ID            SP-API 应用凭证(全店铺共用的兜底)
//   LWA_CLIENT_SECRET
//   LWA_CLIENT_ID_<店铺>      该店铺自己注册的 app;多主体隔离时每店一套,
//   LWA_CLIENT_SECRET_<店铺>  未配置则回落到上面的全局值
//   RT_SP_<店铺>_<区域>       各店铺 SP refresh_token,区域 NA/EU/FE
//                            例:RT_SP_SHOP_A_NA=Atzr|xxx
//   SELLER_ID_<店铺>_<区域>   各店铺、区域的 Seller ID（Listing 命令需要）
//                            例:SELLER_ID_SHOP_A_NA=A1EXAMPLE
//   ADS_CLIENT_ID            广告应用凭证(可与 LWA_* 相同,分开配置)
//   ADS_CLIENT_SECRET
//   ADS_CLIENT_ID_<店铺>      同上,按店铺覆盖
//   ADS_CLIENT_SECRET_<店铺>
//   RT_ADS_<店铺>            各店铺广告 refresh_token(广告无区域之分,LWA 通用)
//                            例:RT_ADS_SHOP_A=Atzr|yyy
//   PROXY_<店铺>             该店铺的出口代理;配了就从这个店铺自己的 IP 兑换令牌
//                            例:PROXY_SHOP_A=http://user:pass@tinyproxy:8888
//   EGRESS_LABEL_<店铺>       出口标签,只写进审计日志便于核对(不含密码)
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
// fetch 和 ProxyAgent 必须来自同一个 undici:Node 内部虽然也是 undici,但没把
// ProxyAgent 暴露出来,把 npm 版的 ProxyAgent 传给内置 fetch 会因为两份 undici
// 的内部符号不一致而失败(amz-cli 的 net/egress.ts 踩过同一个坑)。
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { parseMintApi, parseMintRegion, readRequestBody, remainingSeconds, SERVE_MARGIN_MS } from './protocol.mjs';

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
// marketplace 国家码 → 区域的映射在 protocol.mjs(与 CLI 的 regions.ts 对齐,便于单测)

// ── 出口代理(按店铺)────────────────────────────────────────────────
//
// 配了 PROXY_<店铺>,该店铺的 LWA 令牌兑换就从这个店铺自己的出口 IP 发出
// —— Broker 本机的 IP 对亚马逊完全不可见,多主体隔离连"刷新令牌"这一步也成立。
// 所以 Broker 与某个主体的代理同机部署不再构成牵连。
//
// 与 amz-cli 的 net/egress.ts 保持同一套约定:
//   1. 未配置 = 直连。单主体部署不需要任何开关,不填即可。
//   2. 配置了代理但连不上 = 直接失败,绝不回退直连。
//      这里比 CLI 那边更要紧:一旦静默回退,Broker 的真实 IP 就直接暴露给亚马逊,
//      而且不会有任何人发现——正是这套方案要防的东西。

const proxyAgents = new Map();

/** 代理地址里可以示人的部分(协议+主机),用于日志与报错。绝不返回用户名密码。 */
function redactProxy(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(代理地址无法解析)';
  }
}

/** 该店铺配置的代理地址;未配置返回 null(= 直连)。 */
function proxyUrlFor(store) {
  const v = process.env[`PROXY_${store}`]?.trim();
  return v ? v : null;
}

/** 取(或创建)该代理的 dispatcher。ProxyAgent 持有连接池,必须复用。 */
function proxyAgentFor(url) {
  const cached = proxyAgents.get(url);
  if (cached) return cached;
  // 地址非法在这里抛 —— 此时一个字节都还没发出去。
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http:// 或 https:// 的代理地址,当前是 "${parsed.protocol}"`);
  }
  const agent = new ProxyAgent(url);
  proxyAgents.set(url, agent);
  return agent;
}

/** 审计用的出口标识:优先 EGRESS_LABEL_<店铺>,否则用脱敏后的代理地址。 */
function egressLabelFor(store, proxyUrl) {
  const label = process.env[`EGRESS_LABEL_${store}`]?.trim();
  if (label) return label;
  return proxyUrl ? redactProxy(proxyUrl) : 'direct';
}

/**
 * 该店铺该 API 用的应用凭证。
 * 优先按店铺(多主体各自注册的 app,配合各自出口 IP 才是一致的身份),
 * 未配置回落到全局(单主体,或有意共用一个 app 的 ERP 式部署)。
 */
function appCredentialsFor(api, store) {
  const prefix = api === 'ads' ? 'ADS' : 'LWA';
  const pick = (name) =>
    process.env[`${prefix}_${name}_${store}`]?.trim() || process.env[`${prefix}_${name}`]?.trim();
  return { prefix, clientId: pick('CLIENT_ID'), clientSecret: pick('CLIENT_SECRET') };
}

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

// 进程内 token 缓存,key = api:store:region。
//
// 存的是亚马逊那边的**真实**到期时刻(realExpiresAt):提前 120 秒停止发放
// (serveUntil),但每次返回都按真实剩余寿命重算 expires_in。
//
// 不能回填铸票时的 3600 —— 那样 CLI 会把一张只剩两分钟的票当成新票缓存近一小时
// (broker.ts 按 expires_in - 60 缓存),常驻进程(MCP)会连着吃将近一小时的 401,
// 而 CLI 把 401 归成 auth_expired 且不重试,报出来的是"授权已过期,请重新授权"
// ——完全指错方向,人会跑去查开发者中心。
const tokenCache = new Map();

/**
 * 换票。返回 {token, cached, egress} 或 {error, detail, status, egress}。
 * token 就是原样发给 CLI 的响应体,不夹带任何内部字段。
 */
async function mintToken({ store, api, region }) {
  const proxyUrl = proxyUrlFor(store);
  const egress = egressLabelFor(store, proxyUrl);

  const cacheKey = `${api}:${store}:${region}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.serveUntil) {
    return {
      token: { ...cached.token, expires_in: remainingSeconds(cached.realExpiresAt) },
      cached: true,
      egress,
    };
  }

  const { prefix, clientId, clientSecret } = appCredentialsFor(api, store);
  let refreshToken, endpoint, extra = {};
  if (api === 'sp-api') {
    refreshToken = process.env[`RT_SP_${store}_${region.toUpperCase()}`];
    endpoint = SP_ENDPOINTS[region];
    const sellerId = process.env[`SELLER_ID_${store}_${region.toUpperCase()}`]?.trim();
    if (sellerId) extra = { seller_id: sellerId };
  } else {
    refreshToken = process.env[`RT_ADS_${store}`];
    endpoint = Object.hasOwn(ADS_ENDPOINTS, region) ? ADS_ENDPOINTS[region] : ADS_ENDPOINTS.na;
    // 广告调用需要 ClientId 头;client_id 是公开标识符,可下发
    extra = { client_id: clientId };
  }

  if (!refreshToken) {
    const envName = api === 'sp-api' ? `RT_SP_${store}_${region.toUpperCase()}` : `RT_ADS_${store}`;
    return { error: 'store_not_configured', detail: `环境变量 ${envName} 未配置`, status: 404, egress };
  }
  if (!clientId || !clientSecret) {
    return {
      error: 'app_credentials_missing',
      detail: `应用凭证未配置:需要 ${prefix}_CLIENT_ID_${store}/${prefix}_CLIENT_SECRET_${store},或全局的 ${prefix}_CLIENT_ID/${prefix}_CLIENT_SECRET`,
      status: 500,
      egress,
    };
  }

  // 配了代理就只走代理。dispatcher 在发请求前构造:地址写错在这里就暴露,
  // 而不是变成一次"悄悄直连"。
  let dispatcher;
  if (proxyUrl) {
    try {
      dispatcher = proxyAgentFor(proxyUrl);
    } catch (err) {
      return {
        error: 'invalid_proxy',
        detail: `PROXY_${store} 配置有误:${err.message}`,
        status: 500,
        egress,
      };
    }
  }

  let resp;
  try {
    resp = await undiciFetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    // 绝不回退直连(约定 2)。宁可这个店铺换不到票,也不能让 Broker 的 IP 见光。
    return {
      error: proxyUrl ? 'proxy_unreachable' : 'lwa_unreachable',
      detail: proxyUrl
        ? `经代理 ${redactProxy(proxyUrl)} 兑换令牌失败(未回退直连):${err.message}`
        : `连接 LWA 失败:${err.message}`,
      status: 502,
      egress,
    };
  }

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || typeof body.access_token !== 'string') {
    return {
      error: 'lwa_exchange_failed',
      detail: `LWA HTTP ${resp.status}(refresh token 可能已失效,需要重新授权)`,
      status: 502,
      egress,
    };
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  const realExpiresAt = Date.now() + expiresIn * 1000;
  const token = { access_token: body.access_token, expires_in: expiresIn, endpoint, ...extra };
  tokenCache.set(cacheKey, { token, realExpiresAt, serveUntil: realExpiresAt - SERVE_MARGIN_MS });
  return { token, cached: false, egress };
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
      // region 直接给,或从 marketplace 国家码映射(与规格 §5.2 的 body 等价);
      // 认不出的 marketplace 直接 400,绝不静默回落到 na(那会发错区域的票)
      const regionResult = parseMintRegion(parsed);
      if (regionResult.error) {
        return json(res, 400, { error: regionResult.error, detail: regionResult.detail });
      }
      const region = regionResult.region;

      if (!store) return json(res, 400, { error: 'missing_store' });
      if (!api) return json(res, 400, { error: 'invalid_api', detail: String(parsed.api ?? '') });
      // hasOwn 而非 truthy:SP_ENDPOINTS['constructor'] 这类原型链属性是 truthy,
      // 直接索引会让 region="constructor" 通过校验,再往下拼出无意义的 endpoint。
      if (!Object.hasOwn(SP_ENDPOINTS, region)) {
        return json(res, 400, { error: 'invalid_region', detail: region });
      }

      const authorization = authorize(member, { store, api, region });
      if (!authorization.ok) {
        audit({ event: 'mint_denied', member, store, api, region, reason: authorization.reason });
        return json(res, 403, { error: 'forbidden', detail: '该成员没有此店铺/API/区域的凭证权限' });
      }

      const result = await mintToken({ store, api, region });
      const ok = !result.error;
      // egress 记的是这次令牌兑换从哪个出口发出去的(脱敏),事后核对多主体隔离
      // 是否真的生效;cached=true 表示没有真的去 LWA,所以没走出口。
      audit({
        event: 'mint',
        member,
        store,
        api,
        region,
        ok,
        egress: result.egress,
        ...(ok ? { cached: result.cached === true } : { error: result.error }),
      });

      if (!ok) return json(res, result.status ?? 500, { error: result.error, detail: result.detail });
      return json(res, 200, result.token);
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
// HOST:平台部署(Zeabur)不填=0.0.0.0;自有 VPS 上由反代(caddy/nginx)终结 TLS 时
// 必须设 HOST=127.0.0.1,不额外开公网端口(README"与出口代理同机"一节)。
const host = (process.env.HOST ?? '0.0.0.0').trim();
server.listen(port, host, () => {
  audit({ event: 'startup', host, port, team_members: parseTeamTokens().map((t) => t.name) });
});
