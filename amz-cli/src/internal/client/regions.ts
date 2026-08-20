// Region 路由:marketplaceId ↔ 国家 ↔ SP-API 端点
//
// 数据来源(2026-07-13 从官方文档核实):
//   https://developer-docs.amazon.com/sp-api/docs/marketplace-ids
//   https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints
// 其中 NA 四国的 ID 已与真实账号的 getMarketplaceParticipations 返回交叉验证一致。

export type Region = 'na' | 'eu' | 'fe';

export const SP_API_ENDPOINTS: Record<Region, string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

// 沙盒端点(2026-07-14 官方文档核实)。静态沙盒:请求参数必须匹配
// OpenAPI 模型 x-amzn-api-sandbox 里预定义的示例值才返回 mock 响应。
export const SP_API_SANDBOX_ENDPOINTS: Record<Region, string> = {
  na: 'https://sandbox.sellingpartnerapi-na.amazon.com',
  eu: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
  fe: 'https://sandbox.sellingpartnerapi-fe.amazon.com',
};

export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/** 沙盒开关:.env 里 SP_API_SANDBOX=true 时,所有 SP-API 调用走沙盒端点。 */
export function isSandboxMode(): boolean {
  return (process.env['SP_API_SANDBOX'] ?? '').trim().toLowerCase() === 'true';
}

export interface MarketplaceInfo {
  id: string;
  country: string; // ISO 国家码,同事用它当 --marketplace 的值
  region: Region;
  name: string;
  currency: string; // ISO 4217,费用预估等接口用
}

/**
 * 官方在售市场全集(sp-api marketplace-ids 文档口径)。
 * NA 四国已与真实账号 getMarketplaceParticipations 交叉验证;
 * 2026-08-20 补录 EU 扩展站(PL/NL/SE/BE/TR/IE 等)与 FE——欧洲店铺普遍带这些站点,
 * 表里缺一个,--marketplace 连国家码带 marketplaceId 都会被拒。
 * 新站点接入时可用 auth whoami 的返回交叉核对 marketplaceId。
 */
export const MARKETPLACES: MarketplaceInfo[] = [
  // —— NA ——(与真实账号 API 返回交叉验证)
  { id: 'ATVPDKIKX0DER', country: 'US', region: 'na', name: 'Amazon.com', currency: 'USD' },
  { id: 'A2EUQ1WTGCTBG2', country: 'CA', region: 'na', name: 'Amazon.ca', currency: 'CAD' },
  { id: 'A1AM78C64UM0Y8', country: 'MX', region: 'na', name: 'Amazon.com.mx', currency: 'MXN' },
  { id: 'A2Q3Y263D00KWC', country: 'BR', region: 'na', name: 'Amazon.com.br', currency: 'BRL' },
  // —— EU ——(官方文档核实;接入 EU 店铺时再用真实账号交叉验证一遍)
  { id: 'A1F83G8C2ARO7P', country: 'UK', region: 'eu', name: 'Amazon.co.uk', currency: 'GBP' },
  { id: 'A1PA6795UKMFR9', country: 'DE', region: 'eu', name: 'Amazon.de', currency: 'EUR' },
  { id: 'A13V1IB3VIYZZH', country: 'FR', region: 'eu', name: 'Amazon.fr', currency: 'EUR' },
  { id: 'APJ6JRA9NG5V4', country: 'IT', region: 'eu', name: 'Amazon.it', currency: 'EUR' },
  { id: 'A1RKKUPIHCS9HS', country: 'ES', region: 'eu', name: 'Amazon.es', currency: 'EUR' },
  { id: 'A1805IZSGTT6HS', country: 'NL', region: 'eu', name: 'Amazon.nl', currency: 'EUR' },
  { id: 'A2NODRKZP88ZB9', country: 'SE', region: 'eu', name: 'Amazon.se', currency: 'SEK' },
  { id: 'A1C3SOZRARQ6R3', country: 'PL', region: 'eu', name: 'Amazon.pl', currency: 'PLN' },
  { id: 'AMEN7PMS3EDWL', country: 'BE', region: 'eu', name: 'Amazon.com.be', currency: 'EUR' },
  { id: 'A28R8C7NBKEWEA', country: 'IE', region: 'eu', name: 'Amazon.ie', currency: 'EUR' },
  { id: 'A33AVAJ2PDY3EV', country: 'TR', region: 'eu', name: 'Amazon.com.tr', currency: 'TRY' },
  { id: 'A2VIGQ35RCS4UG', country: 'AE', region: 'eu', name: 'Amazon.ae', currency: 'AED' },
  { id: 'A17E79C6D8DWNP', country: 'SA', region: 'eu', name: 'Amazon.sa', currency: 'SAR' },
  { id: 'ARBP9OOSHTCHU', country: 'EG', region: 'eu', name: 'Amazon.eg', currency: 'EGP' },
  { id: 'A21TJRUUN4KGV', country: 'IN', region: 'eu', name: 'Amazon.in', currency: 'INR' },
  { id: 'AE08WJ6YKNBMC', country: 'ZA', region: 'eu', name: 'Amazon.co.za', currency: 'ZAR' },
  // —— FE ——(官方文档核实)
  { id: 'A1VC38T7YXB528', country: 'JP', region: 'fe', name: 'Amazon.co.jp', currency: 'JPY' },
  { id: 'A39IBJ37TRP1C6', country: 'AU', region: 'fe', name: 'Amazon.com.au', currency: 'AUD' },
  { id: 'A19VAU5U5O7RUS', country: 'SG', region: 'fe', name: 'Amazon.sg', currency: 'SGD' },
];

/** 按国家码(US/DE/…,大小写不敏感)查市场。查不到返回 undefined。 */
export function marketplaceByCountry(country: string): MarketplaceInfo | undefined {
  const c = country.trim().toUpperCase();
  // GB 是 UK 的 ISO 标准写法,两者都接受
  const normalized = c === 'GB' ? 'UK' : c;
  return MARKETPLACES.find((m) => m.country === normalized);
}

/** 按 marketplaceId 查市场。 */
export function marketplaceById(id: string): MarketplaceInfo | undefined {
  return MARKETPLACES.find((m) => m.id === id);
}
