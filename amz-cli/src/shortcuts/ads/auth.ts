// ads auth-url / auth-exchange —— 广告 API 授权辅助(拿 ADS_REFRESH_TOKEN 用)
//
// 依据(2026-07-14 官方文档核实):
//   授权页:https://www.amazon.com/ap/oa
//     ?client_id=...&scope=advertising::campaign_management
//     &response_type=code&redirect_uri=...
//   换 token:POST https://api.amazon.com/auth/o2/token(NA;EU 用
//     api.amazon.co.uk,FE 用 api.amazon.co.jp)
//     body: grant_type=authorization_code&code=...&client_id=...
//           &client_secret=...&redirect_uri=...
//   前提:redirect_uri 必须先添加进 Security Profile 的
//   Web Settings → Allowed Return URLs(developer.amazon.com)
//
// ⚠️ auth-exchange 会在终端显示 refresh_token——请【自己在终端运行】,
//    不要在任何会被记录/共享的环境里跑,输出不要发给任何人。

import { AmzError } from '../../internal/errs/errors.js';
import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';

const DEFAULT_REDIRECT = 'https://amazon.com';
const ADS_SCOPE = 'advertising::campaign_management';
const TEST_ACCOUNT_SCOPE = 'advertising::test:create_account';

const TOKEN_ENDPOINTS: Record<string, string> = {
  na: 'https://api.amazon.com/auth/o2/token',
  eu: 'https://api.amazon.co.uk/auth/o2/token',
  fe: 'https://api.amazon.co.jp/auth/o2/token',
};

function requireAdsClientId(): string {
  const v = process.env['ADS_CLIENT_ID']?.trim();
  if (!v) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'ads.client_id_missing',
      param: 'ADS_CLIENT_ID',
      hintAgent: 'report_to_human',
      hintHuman: '请先把广告应用的 Client ID 填进 .env 的 ADS_CLIENT_ID(在 developer.amazon.com 的 Security Profile 里查看)。',
      message: 'ADS_CLIENT_ID is not set',
    });
  }
  return v;
}

export const adsAuthUrl: ToolDefinition = {
  service: 'ads',
  command: 'auth-url',
  description: '生成广告 API 授权链接(浏览器打开→登录授权→从跳转地址栏复制 code)',
  mutation: 'none',
  flags: [
    {
      name: 'redirect-uri',
      desc: `回调地址,默认 ${DEFAULT_REDIRECT}(必须先添加进 Security Profile 的 Allowed Return URLs)`,
    },
    {
      name: 'test-account',
      type: 'boolean',
      desc: '同时申请创建广告测试账户所需的 advertising::test:create_account scope',
    },
  ],
  execute: async (ctx) => {
    const clientId = requireAdsClientId();
    const redirectUri = strFlag(ctx.flags, 'redirectUri') ?? DEFAULT_REDIRECT;
    const url =
      'https://www.amazon.com/ap/oa?' +
      new URLSearchParams({
        client_id: clientId,
        scope: ctx.flags['testAccount'] ? `${ADS_SCOPE} ${TEST_ACCOUNT_SCOPE}` : ADS_SCOPE,
        response_type: 'code',
        redirect_uri: redirectUri,
      }).toString();
    return {
      authorize_url: url,
      steps: [
        `0. 前提:去 developer.amazon.com → 你的 Security Profile → Web Settings → Allowed Return URLs 添加 ${redirectUri}`,
        '1. 用浏览器打开 authorize_url,用【广告账户拥有者】的亚马逊账号登录并同意授权',
        `2. 授权后浏览器会跳转到 ${redirectUri}?code=xxxx&scope=...——从地址栏复制 code= 后面的值(& 之前)`,
        '3. 自己在终端运行:amz-cli ads auth-exchange --code <刚复制的值>(输出含敏感令牌,勿在共享环境运行)',
      ],
    };
  },
};

export const adsAuthExchange: ToolDefinition = {
  service: 'ads',
  command: 'auth-exchange',
  description: '用授权码换 ADS_REFRESH_TOKEN(输出含敏感令牌:请自己在终端运行,勿外发)',
  mutation: 'none',
  requiresTty: true,
  flags: [
    { name: 'code', desc: '授权后地址栏里的 code 值(必填)', required: true },
    {
      name: 'redirect-uri',
      desc: `与 auth-url 用的一致,默认 ${DEFAULT_REDIRECT}`,
    },
    { name: 'region', desc: '换取端点区域 na|eu|fe,默认 na', enum: ['na', 'eu', 'fe'] },
  ],
  execute: async (ctx) => {
    const clientId = requireAdsClientId();
    const clientSecret = process.env['ADS_CLIENT_SECRET']?.trim();
    if (!clientSecret) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.client_secret_missing',
        param: 'ADS_CLIENT_SECRET',
        hintAgent: 'report_to_human',
        hintHuman: '请先把 Client Secret 填进 .env 的 ADS_CLIENT_SECRET。',
        message: 'ADS_CLIENT_SECRET is not set',
      });
    }
    const region = (strFlag(ctx.flags, 'region') ?? 'na').toLowerCase();
    const endpoint = TOKEN_ENDPOINTS[region];
    if (!endpoint) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'ads.invalid_region',
        param: '--region',
        hintAgent: 'fix_param',
        hintHuman: '--region 只能是 na / eu / fe。',
        message: `invalid region: ${region}`,
      });
    }

    ctx.progress('· 正在用授权码换取令牌...');
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: strFlag(ctx.flags, 'code')!,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: strFlag(ctx.flags, 'redirectUri') ?? DEFAULT_REDIRECT,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok || typeof body.refresh_token !== 'string') {
      throw new AmzError({
        type: 'auth_expired',
        subtype: 'ads.code_exchange_failed',
        hintAgent: 'report_to_human',
        hintHuman:
          `授权码换取失败(HTTP ${resp.status}:${String(body.error ?? '')} ${String(body.error_description ?? '')})。` +
          '常见原因:code 已过期(只能用一次且几分钟内有效,重新走 auth-url)、redirect-uri 与授权时不一致、Client Secret 填错。',
        message: `code exchange failed: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 300)}`,
        status: resp.status,
      });
    }
    return {
      '⚠️': '以下 refresh_token 是长期凭证,只填进 .env,不要发给任何人(包括聊天/截图)',
      fill_into_env: {
        ADS_REFRESH_TOKEN: body.refresh_token,
      },
      next: '填好后运行:amz-cli ads profiles 验证(返回广告账户列表即成功)',
    };
  },
};
