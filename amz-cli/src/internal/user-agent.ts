// User-Agent 解析 —— 按账号可配。
//
// SP-API 要求请求带 User-Agent,推荐格式:AppName/Version (Language=...; Platform=...)。
// 在 accounts/<账号>.env 里设 SP_API_USER_AGENT(和可选 ADS_USER_AGENT),
// 填该账号所用应用在开发者中心注册的名字与版本号,让请求头与注册信息一致。
//
// 未配置时回退到一个通用默认(建议按账号各配一份,填各自的应用名)。

const DEFAULT_UA = 'amz-cli (Language=Node.js)';

/** SP-API 请求用的 User-Agent。优先该账号 .env 的 SP_API_USER_AGENT。 */
export function spApiUserAgent(): string {
  const custom = process.env['SP_API_USER_AGENT']?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_UA;
}

/** Ads API 请求用的 User-Agent。优先 ADS_USER_AGENT,其次 SP_API_USER_AGENT。 */
export function adsUserAgent(): string {
  // 逐级判空:ADS_USER_AGENT 设了但为空串/空白时也要回退到 SP_API_USER_AGENT,
  // 与模板"留空则复用"的承诺一致(?? 只认 undefined,空串会短路)。
  const ads = process.env['ADS_USER_AGENT']?.trim();
  if (ads) return ads;
  return spApiUserAgent();
}
