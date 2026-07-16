// ads test-account —— 广告 API 的"沙盒":创建/查询测试广告账户
//
// 依据(2026-07-13 官方 Postman 集合逐字核实):
//   POST /testAccounts   Body: {countryCode, accountType}   创建测试账户
//   GET  /testAccounts                                       查创建状态
//   (账户级接口,不带 Amazon-Advertising-API-Scope 头)
//
// 用途:广告写操作(campaign-create 等)的首次验证场所——测试账户里的
// 广告不真实投放、不花钱。这就是"广告先过沙盒"的落地方式。
// 注意:创建测试账户同样需要 Ads API 准入(凭证问题与其他 ads 命令相同)。

import type { ToolDefinition } from '../../tools/types.js';
import { strFlag } from '../common.js';
import { ADS_REGION_FLAG, adsRegion } from './common.js';

export const adsTestAccountCreate: ToolDefinition = {
  service: 'ads',
  command: 'test-account-create',
  description: '创建广告测试账户(沙盒:里面的广告不投放不花钱,用于验证写操作)',
  mutation: 'reversible',
  flags: [
    { name: 'country', desc: '国家码,默认 US', enum: ['US', 'CA', 'MX', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP'] },
    {
      name: 'account-type',
      desc: '账户类型,默认 VENDOR。官方示例含 AUTHOR/VENDOR;卖家场景一般用 VENDOR 或咨询文档',
      enum: ['VENDOR', 'AUTHOR'],
    },
    ADS_REGION_FLAG,
  ],
  describe: (flags) =>
    `创建一个 ${(strFlag(flags, 'country') ?? 'US').toUpperCase()} 站点的广告测试账户` +
    `(类型 ${(strFlag(flags, 'accountType') ?? 'VENDOR').toUpperCase()};沙盒性质,不影响任何真实账户)`,
  dryRun: async (ctx) => {
    const body = {
      countryCode: (strFlag(ctx.flags, 'country') ?? 'US').toUpperCase(),
      accountType: (strFlag(ctx.flags, 'accountType') ?? 'VENDOR').toUpperCase(),
    };
    return {
      dry_run_note: '将创建一个广告测试账户(沙盒),不影响任何真实账户。--confirm 执行。',
      endpoint: 'POST /testAccounts',
      payload: body,
    };
  },
  execute: async (ctx) => {
    ctx.progress('· 正在创建广告测试账户...');
    const resp = await ctx.adsClient.request('POST', '/testAccounts', {
      region: adsRegion(ctx.flags),
      body: {
        countryCode: (strFlag(ctx.flags, 'country') ?? 'US').toUpperCase(),
        accountType: (strFlag(ctx.flags, 'accountType') ?? 'VENDOR').toUpperCase(),
      },
    });
    return {
      result: resp,
      next: '用 ads test-account-status 查创建进度;完成后 ads profiles 里会出现测试账户的 profileId',
    };
  },
};

export const adsTestAccountStatus: ToolDefinition = {
  service: 'ads',
  command: 'test-account-status',
  description: '查询广告测试账户的创建状态',
  mutation: 'none',
  flags: [ADS_REGION_FLAG],
  execute: async (ctx) => {
    ctx.progress('· 正在查询测试账户状态...');
    const resp = await ctx.adsClient.request('GET', '/testAccounts', { region: adsRegion(ctx.flags) });
    return { accounts: resp };
  },
};
