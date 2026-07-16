// SP-API 凭证链路最小验证 (Hello World)
//
// 用法(在 amz-cli 目录下):
//   1. 复制 .env.example 为 .env,填入你的三个凭证
//   2. node --env-file=.env scripts/hello.mjs
//
// 流程: refresh_token --(LWA)--> access_token --> getMarketplaceParticipations
//
// 关键点: 2023年10月起 SP-API 已取消 AWS SigV4 签名要求,
// 只需把 LWA access_token 放进 header `x-amz-access-token` 即可。
// 因此本脚本零依赖——只用 Node 20 自带的 fetch。
//
// 输出约定(预演错误契约):进度与错误 → stderr;成功的纯数据 → stdout。

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const REGION_ENDPOINTS = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

function need(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[缺少凭证] 环境变量 ${name} 未设置。请复制 .env.example 为 .env 并填写。`);
    process.exit(1);
  }
  return v.trim();
}

async function main() {
  const clientId = need('LWA_CLIENT_ID');
  const clientSecret = need('LWA_CLIENT_SECRET');
  const refreshToken = need('LWA_REFRESH_TOKEN');
  const region = (process.env.SP_API_REGION || 'na').trim().toLowerCase();

  const endpoint = REGION_ENDPOINTS[region];
  if (!endpoint) {
    console.error(`[配置错误] SP_API_REGION="${region}" 无效,应为 na | eu | fe`);
    process.exit(1);
  }

  // —— 第 1 步:用 refresh_token 换 access_token ——
  console.error('· 正在向 LWA 换取 access_token ...');
  const tokenResp = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const tokenBody = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok) {
    console.error(`[LWA 换取失败] HTTP ${tokenResp.status}`);
    console.error(JSON.stringify(tokenBody, null, 2));
    console.error('常见原因:client_id / client_secret / refresh_token 填错,或 refresh_token 已失效。');
    process.exit(2);
  }
  const accessToken = tokenBody.access_token;
  if (!accessToken) {
    console.error('[LWA 换取异常] 响应里没有 access_token:');
    console.error(JSON.stringify(tokenBody, null, 2));
    process.exit(2);
  }
  console.error(`· 已拿到 access_token(有效期 ${tokenBody.expires_in}s)`);

  // —— 第 2 步:调 getMarketplaceParticipations(无需参数,最适合首次握手)——
  console.error(`· 正在调用 getMarketplaceParticipations(region=${region})...`);
  const apiResp = await fetch(`${endpoint}/sellers/v1/marketplaceParticipations`, {
    method: 'GET',
    headers: { 'x-amz-access-token': accessToken },
  });
  const apiBody = await apiResp.json().catch(() => ({}));
  if (!apiResp.ok) {
    console.error(`[SP-API 调用失败] HTTP ${apiResp.status}`);
    console.error(JSON.stringify(apiBody, null, 2));
    if (apiResp.status === 403) {
      console.error('403 常见原因:该店铺尚未授权此应用,或应用缺少「洞察销售伙伴(Selling Partner Insights)」角色。');
    }
    process.exit(3);
  }

  // —— 成功:整理市场列表,纯 JSON 输出到 stdout ——
  const participations = apiBody.payload || [];
  const markets = participations.map((p) => ({
    marketplaceId: p.marketplace?.id,
    country: p.marketplace?.countryCode,
    name: p.marketplace?.name,
    participating: p.participation?.isParticipating,
  }));

  console.error(`\n✅ 凭证链路已打通!该账号在 ${markets.length} 个市场有参与:\n`);
  console.log(JSON.stringify(markets, null, 2));
}

main().catch((err) => {
  console.error('[未预期错误]', err?.stack || err?.message || err);
  process.exit(10);
});
