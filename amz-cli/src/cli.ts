#!/usr/bin/env node
// amz-cli 入口:commander 装配 + .env 加载 + 总错误出口
//
// 错误契约总出口(参照 lark-cli cmd/root.go handleRootError):
// 所有错误最终汇到这里,类型化输出到 stderr,exit code 由错误类型派生。

import { Command } from 'commander';
import { printError } from './internal/errs/output.js';
import { isSandboxMode } from './internal/client/regions.js';
import { extractAccountArg, loadAccount, loadDotEnvIfPresent } from './internal/account.js';
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
import { adsKeywordCampaignLaunch } from './shortcuts/ads/keyword-campaign-launch.js';
import { adsCampaignState } from './shortcuts/ads/campaign-state.js';
import { adsCampaignBudget } from './shortcuts/ads/campaign-budget.js';
import { adsKeywords, adsKeywordBid, adsNegativeKeyword } from './shortcuts/ads/keywords.js';
import { adsTestAccountCreate, adsTestAccountStatus } from './shortcuts/ads/test-account.js';
import { adsAuthUrl, adsAuthExchange } from './shortcuts/ads/auth.js';
import { salesStats } from './shortcuts/sales/stats.js';
import { inventoryList } from './shortcuts/inventory/list.js';
import { feesEstimate } from './shortcuts/fees/estimate.js';
import { shipmentsList, shipmentsItems } from './shortcuts/shipments/list.js';

async function main(): Promise<void> {
  // 先加载共享 .env 以识别 Broker，再让显式账号完整覆盖/隔离店铺凭证。
  loadDotEnvIfPresent();
  const account = extractAccountArg(process.argv);
  if (account) loadAccount(account);

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
    adsKeywordCampaignLaunch,
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
