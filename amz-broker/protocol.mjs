export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/** 缓存命中后仍要提前多久停止发放(毫秒)。 */
export const SERVE_MARGIN_MS = 120_000;

/**
 * 按亚马逊那边的真实到期时刻,算这张票还能用多少秒。
 *
 * 必须按真实剩余算,不能回填铸票时的 expires_in —— CLI(broker.ts)会按
 * expires_in - 60 缓存,回填 3600 会让它把一张只剩两分钟的票当新票用近一小时。
 *
 * 至少返回 1:0 或负数会让 CLI 的缓存时间算成负值,行为不可预期。
 */
export function remainingSeconds(realExpiresAt, now = Date.now()) {
  return Math.max(1, Math.floor((realExpiresAt - now) / 1000));
}

export function parseMintApi(value) {
  return value === 'sp-api' || value === 'ads' ? value : null;
}

// marketplace 国家码 → 区域(与 CLI 的 regions.ts 逐条对齐,官方 marketplace-ids 文档口径)
export const COUNTRY_TO_REGION = {
  US: 'na', CA: 'na', MX: 'na', BR: 'na',
  UK: 'eu', GB: 'eu', DE: 'eu', FR: 'eu', IT: 'eu', ES: 'eu',
  NL: 'eu', SE: 'eu', PL: 'eu', BE: 'eu', IE: 'eu', TR: 'eu',
  AE: 'eu', SA: 'eu', EG: 'eu', IN: 'eu', ZA: 'eu',
  JP: 'fe', AU: 'fe', SG: 'fe',
};

/**
 * 从 mint 请求体解析区域:显式 region 优先;否则由 marketplace 国家码映射。
 * marketplace 给了但映射不到 → 返回错误,绝不静默回落到 na
 * (回落会把 PL 店的令牌换成北美区端点,CLI 拿去调用只会得到一堆 403,方向全错)。
 * 两者都没给 → 默认 na(与 CLI 的默认区域一致)。
 */
/** SP-API 的三个区域;protocol 层自己就校验,不把非法值透传给下游拼端点。 */
export const VALID_REGIONS = ['na', 'eu', 'fe'];

export function parseMintRegion(parsed) {
  const region = String(parsed.region ?? '').toLowerCase().trim();
  // 显式 region 必须在白名单内。用 includes 而不是查对象:普通对象索引会命中
  // 原型链("constructor"/"toString" 都是 truthy),那正是 server.mjs 里堵掉的洞;
  // 这里在协议层就拦住,下游不必再指望兜底。
  if (region) {
    return VALID_REGIONS.includes(region)
      ? { region }
      : { error: 'invalid_region', detail: region };
  }
  const marketplace = String(parsed.marketplace ?? '').trim();
  if (marketplace) {
    // 必须用 hasOwn:普通对象索引会命中原型链,COUNTRY_TO_REGION['constructor']
    // 之类返回 truthy,让非法国家码蒙混过关。凭证服务的输入校验不留这种口子。
    const key = marketplace.toUpperCase();
    return Object.hasOwn(COUNTRY_TO_REGION, key)
      ? { region: COUNTRY_TO_REGION[key] }
      : { error: 'unknown_marketplace', detail: marketplace };
  }
  return { region: 'na' };
}

export async function readRequestBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
