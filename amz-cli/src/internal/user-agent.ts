// User-Agent 解析 —— 按主体(账号)可配,避免"一份代码 5 个主体发同一个 UA"的应用层指纹。
//
// SP-API 要求请求带 User-Agent,推荐格式:AppName/Version (Language=...; Platform=...)。
// 每个主体在自己的 accounts/<店铺>.env 里设 SP_API_USER_AGENT(和可选 ADS_USER_AGENT),
// 对应各自注册的 app 名字与版本号 —— 5 个主体 = 5 个各自独立、都说得通的 UA。
//
// 未配置时回退到一个通用默认(仍建议每个主体各配一份,默认值会让未配置的主体撞在一起)。

const DEFAULT_UA = 'amz-cli (Language=Node.js)';

/** SP-API 请求用的 User-Agent。优先各主体 .env 的 SP_API_USER_AGENT。 */
export function spApiUserAgent(): string {
  const custom = process.env['SP_API_USER_AGENT']?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_UA;
}

/** Ads API 请求用的 User-Agent。优先 ADS_USER_AGENT,其次 SP_API_USER_AGENT。 */
export function adsUserAgent(): string {
  const custom = (process.env['ADS_USER_AGENT'] ?? process.env['SP_API_USER_AGENT'])?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_UA;
}
