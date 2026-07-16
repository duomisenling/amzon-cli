#!/usr/bin/env node
// amz-cli 入口:commander 装配 + .env 加载 + 总错误出口
//
// 错误契约总出口(参照 lark-cli cmd/root.go handleRootError):
// 所有错误最终汇到这里,类型化输出到 stderr,exit code 由错误类型派生。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { AmzError } from './internal/errs/errors.js';
import { printError } from './internal/errs/output.js';
import { isSandboxMode } from './internal/client/regions.js';
import { registerTools } from './tools/registry.js';
import { authWhoami } from './shortcuts/auth/whoami.js';
import { listingSearch } from './shortcuts/listing/catalog-search.js';
import { listingGet } from './shortcuts/listing/catalog-get.js';
import { listingMine, listingSku } from './shortcuts/listing/mine.js';
import { listingSchema } from './shortcuts/listing/schema.js';
import { ordersList } from './shortcuts/orders/list.js';
import { ordersGet } from './shortcuts/orders/get.js';
import { ordersItems } from './shortcuts/orders/items.js';
import {
  reportTypes,
  reportCreate,
  reportStatus,
  reportDownload,
  reportRun,
} from './shortcuts/report/commands.js';
import { feedbackRun } from './shortcuts/feedback/monitor.js';
import { pricingCompetitive } from './shortcuts/pricing/competitive.js';
import { pricingFoep } from './shortcuts/pricing/foep.js';
import { listingUpdate } from './shortcuts/listing/update.js';
import { feedSubmit, feedStatus, feedResult } from './shortcuts/feed/commands.js';
import { adsProfiles, adsCampaigns } from './shortcuts/ads/commands.js';
import { adsReportRun, adsReportStatus } from './shortcuts/ads/report.js';
import { adsCampaignCreate } from './shortcuts/ads/campaign-create.js';
import { adsCampaignState } from './shortcuts/ads/campaign-state.js';
import { adsCampaignBudget } from './shortcuts/ads/campaign-budget.js';
import { adsKeywords, adsKeywordBid, adsNegativeKeyword } from './shortcuts/ads/keywords.js';
import { adsTestAccountCreate, adsTestAccountStatus } from './shortcuts/ads/test-account.js';
import { adsAuthUrl, adsAuthExchange } from './shortcuts/ads/auth.js';
import { salesStats } from './shortcuts/sales/stats.js';
import { inventoryList } from './shortcuts/inventory/list.js';
import { feesEstimate } from './shortcuts/fees/estimate.js';
import { shipmentsList, shipmentsItems } from './shortcuts/shipments/list.js';

/** 解析 KEY=VALUE 格式的 env 文本,返回键值对(跳过注释与空行)。 */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 多账号(店铺)支持:从 argv 提取全局 --account <名称> 并移除(commander 不感知)。
 * 支持 --account foo 和 --account=foo 两种写法。
 */
function extractAccountArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--account');
  if (i >= 0) {
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'account_missing_value',
        param: '--account',
        hintAgent: 'fix_param',
        hintHuman: '--account 后面需要账号名称,例如 --account shop-a。',
        message: '--account requires a value',
      });
    }
    argv.splice(i, 2);
    return value;
  }
  const pref = argv.findIndex((a) => a.startsWith('--account='));
  if (pref >= 0) {
    const value = argv[pref]!.slice('--account='.length);
    argv.splice(pref, 1);
    return value;
  }
  return undefined;
}

/**
 * 按账号名加载凭证,规则(安全优先,绝不静默落到别的账号):
 *   1. 账号名只允许字母/数字/连字符/下划线,防路径注入;
 *   2. ~/.amz-cli/accounts/<名称>.env 存在 → 加载并**覆盖**已有环境变量
 *      (显式 --account 表达的就是"这次用这个账号",必须赢过 .env 和 shell 继承值);
 *   3. 文件不存在但配置了 BROKER_URL → 只切 STORE=<名称大写>,由 Broker 端校验权限;
 *   4. 两者都不满足 → 报错,绝不静默用默认凭证冒充所选账号。
 */
function loadAccount(account: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(account)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_account_name',
      param: '--account',
      hintAgent: 'fix_param',
      hintHuman: `账号名 "${account}" 无效:只能包含字母、数字、连字符和下划线。`,
      message: `invalid account name: ${account}`,
    });
  }
  const file = join(homedir(), '.amz-cli', 'accounts', `${account}.env`);
  if (existsSync(file)) {
    const vars = parseEnvText(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    // 账号文件没显式写 STORE 时,用账号名作为 Broker 店铺代号(local 模式忽略该值)
    if (!('STORE' in vars)) process.env['STORE'] = account.toUpperCase().replace(/-/g, '_');
    process.stderr.write(`👤 [账号] ${account}(凭证来自 ${file})\n`);
    return;
  }
  if (process.env['BROKER_URL']?.trim()) {
    process.env['STORE'] = account.toUpperCase().replace(/-/g, '_');
    process.stderr.write(`👤 [账号] ${account}(Broker 店铺 ${process.env['STORE']})\n`);
    return;
  }
  throw new AmzError({
    type: 'invalid_param',
    subtype: 'account_not_found',
    param: '--account',
    hintAgent: 'report_to_human',
    hintHuman:
      `账号 "${account}" 不存在:没有找到凭证文件 ${file},也没有配置 Broker。` +
      `请创建该文件(内容参考 .env.example)或联系管理员在 Broker 端开通。`,
    message: `account file not found: ${file} (and BROKER_URL not set)`,
  });
}

/** 开发阶段便利:cwd 下有 .env 就加载(不覆盖已有环境变量,不依赖 dotenv)。 */
function loadDotEnvIfPresent(): void {
  if ((process.env['AMZ_CLI_SKIP_DOTENV'] ?? '').trim().toLowerCase() === 'true') return;
  try {
    const vars = parseEnvText(readFileSync('.env', 'utf8'));
    for (const [key, value] of Object.entries(vars)) {
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // 没有 .env 是正常情况(broker 模式/CI),静默跳过
  }
}

async function main(): Promise<void> {
  // --account 必须最先处理:账号凭证覆盖一切,.env 只做共享值兜底
  const account = extractAccountArg(process.argv);
  if (account) loadAccount(account);
  loadDotEnvIfPresent();

  // 沙盒模式显著提示,避免把 mock 数据误当真实数据
  if (isSandboxMode()) {
    process.stderr.write('🧪 [沙盒模式] SP-API 调用走 sandbox 端点,返回的是官方预设的 mock 数据\n');
  }

  const program = new Command();
  program
    .name('amz-cli')
    .description('Amazon SP-API CLI for AI Agents — 给 Agent 用的亚马逊命令行工具')
    .version('0.1.0')
    // 仅用于 --help 展示;实际解析在 extractAccountArg(任意位置可写,先于 commander 处理)
    .option(
      '--account <名称>',
      '多账号:用指定账号的凭证执行(本地=~/.amz-cli/accounts/<名称>.env;Broker=切换店铺)。省略则用默认 .env',
    );

  // 所有功能定义在这里挂载(一个功能 = shortcuts/ 下一个 ToolDefinition)
  registerTools(program, [
    authWhoami,
    listingSearch,
    listingGet,
    listingMine,
    listingSku,
    listingSchema,
    ordersList,
    ordersGet,
    ordersItems,
    salesStats,
    inventoryList,
    feesEstimate,
    shipmentsList,
    shipmentsItems,
    reportTypes,
    reportCreate,
    reportStatus,
    reportDownload,
    reportRun,
    feedbackRun,
    pricingCompetitive,
    pricingFoep,
    // —— 写操作(第二阶段;dry-run/confirm 门槛由框架强制)——
    listingUpdate,
    feedSubmit,
    feedStatus,
    feedResult,
    // —— 广告(只读;规格 §7.4 的授权变更,写操作仍走官方 Ads MCP)——
    adsProfiles,
    adsCampaigns,
    adsReportRun,
    adsReportStatus,
    // —— 广告写操作(dry-run/confirm 门槛;首次验证走测试账户=广告沙盒)——
    adsCampaignCreate,
    adsCampaignState,
    adsCampaignBudget,
    adsKeywords,
    adsKeywordBid,
    adsNegativeKeyword,
    adsTestAccountCreate,
    adsTestAccountStatus,
    adsAuthUrl,
    adsAuthExchange,
  ]);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  process.exit(printError(err));
});
