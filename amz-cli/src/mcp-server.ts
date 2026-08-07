#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractAccountArg, loadAccount, loadDotEnvIfPresent } from './internal/account.js';
import { flushAuditUploads, setAuditAccount, setAuditOperation } from './internal/audit.js';
import { AdsClient } from './internal/client/ads-client.js';
import { closeEgressAgents } from './internal/net/egress.js';
import { readPackageInfo } from './internal/package-info.js';
import type { SpApiClient } from './internal/client/client.js';
import {
  issuePreviewToken,
  verifyAndConsumePreviewToken,
} from './internal/confirmation/preview-token.js';
import { runtimeConfirmationSnapshot } from './internal/confirmation/runtime-snapshot.js';
import { AmzError, wrapInternal } from './internal/errs/errors.js';
import {
  executeKeywordCampaignPlan,
  keywordCampaignPlanHash,
  keywordCampaignPlanSchema,
  keywordCampaignPreview,
  preflightKeywordCampaignProducts,
  type KeywordCampaignPlan,
} from './shortcuts/ads/keyword-campaign-launch.js';
import { buildToolContext } from './tools/context.js';
import type { ToolClientFactories } from './tools/context.js';
import {
  assertMcpWriteAllowed,
  mcpApplyPermission,
  mcpErrorResult,
  mcpResult,
  previewTokenSchema,
} from './mcp/common.js';
import { registerOperationalWriteTools } from './mcp/write-tools.js';
import { MultiAccountMcpRouter, createStdioAccountConnector } from './mcp/account-router.js';
import { parseMcpAccounts } from './setup/mcp-config.js';

const MCP_OPERATION = 'mcp launch_keyword_campaign';
const KEYWORD_CAMPAIGN_PERMISSION = 'ads.keyword-campaign-launch';

type AdsClientFactory = () => AdsClient;

function tokenFlags(plan: KeywordCampaignPlan): Record<string, unknown> {
  return { planHash: keywordCampaignPlanHash(plan) };
}

function tokenSnapshot(plan: KeywordCampaignPlan, account: string): Record<string, unknown> {
  return { account, runtime: runtimeConfirmationSnapshot(), planHash: keywordCampaignPlanHash(plan) };
}

export interface AmazonMcpClientFactories extends ToolClientFactories {
  spClient?: () => SpApiClient;
  adsClient?: () => AdsClient;
}

/** 可注入客户端，供无网络单元测试验证 MCP 数据流。 */
export function createAmazonMcpServer(
  factories: AmazonMcpClientFactories = {},
  account: string = 'default',
): McpServer {
  const server = new McpServer(
    // 版本从随包 package.json 动态读取,避免与 npm 版本漂移(硬编码曾漂到过时值)
    { name: `amz-cli-safe-writes-${account}`, version: readPackageInfo().version },
    {
      instructions:
        `当前 MCP 服务固定绑定店铺:${account}。所有 prepare_* 工具只预览；` +
        'apply_* 和 launch_keyword_campaign 会正式写入 Amazon。' +
        '客户端必须对每一次正式写工具调用向真人请求批准，不得自动批准或使用 bypassPermissions。',
    },
  );

  // 在 registerTool 上包一层:每个工具 handler 执行前把操作名标进审计。
  // CLI 路径由 tools/registry.ts 的 runTool 标注;MCP 长驻进程若不标注,
  // 审计行的 op 恒为空,中央看板无法区分某次写入来自哪个 MCP 工具。
  // 包在注册处(而不是逐个 handler 里加)让后续所有注册自动生效。
  const originalRegisterTool = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: (...cbArgs: unknown[]) => unknown,
  ) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: (...cbArgs: unknown[]) => unknown,
  ) =>
    originalRegisterTool(name, config, (...cbArgs: unknown[]) => {
      setAuditOperation(`mcp ${name}`);
      return cb(...cbArgs);
    });

  // 长驻 MCP 进程没有 CLI main() 那样的 finally 出口:stdio 连接关闭(Cherry 退出/
  // 断开)时补上尾部审计行的中央上报,并关掉代理连接池 —— 不关的话配了代理的
  // 账号进程可能一直不退出。都是旁路清理,失败不影响已完成的业务。
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    void flushAuditUploads().finally(() => {
      void closeEgressAgents();
    });
  };

  registerOperationalWriteTools(server, factories, account);

  server.registerTool(
    'prepare_keyword_campaign',
    {
      title: `【${account}】预览完整关键词广告`,
      description:
        `固定店铺:${account}。products[].sku 必填；只有 ASIN 时必须先用 listing mine 批量解析。` +
        '预览会用只读 Listings API 核实全部 SKU 属于当前店铺和站点，不调用 Amazon 写接口。' +
        '返回绑定完整方案和运行环境、15 分钟有效的一次性 previewToken。',
      inputSchema: { plan: keywordCampaignPlanSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ plan }) => {
      try {
        const preflight = await preflightKeywordCampaignProducts(buildToolContext({}, factories).client, plan);
        const issued = issuePreviewToken(MCP_OPERATION, tokenFlags(plan), Date.now(), tokenSnapshot(plan, account));
        // 与 write-tools 的 prepare_* 一致:预览永远可做,但预告 launch 会不会被放行
        const permission = mcpApplyPermission(KEYWORD_CAMPAIGN_PERMISSION);
        return mcpResult({
          account,
          ...keywordCampaignPreview(plan),
          productPreflight: preflight,
          previewToken: issued.token,
          previewExpiresAt: issued.expiresAt,
          applyAllowed: permission.allowed,
          ...(permission.allowed ? {} : { applyBlockedReason: permission.reason }),
          nextStep: permission.allowed
            ? '真人核对全部关键词、竞价、预算和最终启用状态后，批准 launch_keyword_campaign；任何方案变化都必须重新预览。'
            : '当前环境未放行 launch_keyword_campaign 的正式写入，本令牌无法兑现。' +
              '如需执行，请联系管理员调整 MCP 写入配置后重新预览。',
        });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    'launch_keyword_campaign',
    {
      title: `【${account}】创建并启动完整关键词广告`,
      description:
        `固定店铺:${account}。高风险写操作：消费 prepare 返回的一次性令牌，` +
        'products[].sku 必须已经解析并通过店铺/站点校验；正式写入前会再次只读核实，失败时不会创建 Campaign。' +
        '在 Amazon 创建 Campaign、广告组、商品广告和关键词；' +
        '全部回查成功后才按方案启用。客户端必须在每次调用前展示方案并向真人请求批准。',
      inputSchema: { plan: keywordCampaignPlanSchema, previewToken: previewTokenSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ plan, previewToken }) => {
      try {
        assertMcpWriteAllowed(KEYWORD_CAMPAIGN_PERMISSION);
        // 在消费一次性令牌和创建任何 Ads 对象之前复核，失败时允许修正后重新预览。
        await preflightKeywordCampaignProducts(buildToolContext({}, factories).client, plan);
        // Cherry 已批准本次破坏性工具调用后，才会进入 handler。令牌在首次正式执行前原子消费。
        verifyAndConsumePreviewToken(
          MCP_OPERATION,
          tokenFlags(plan),
          previewToken,
          Date.now(),
          tokenSnapshot(plan, account),
        );
        const launched = await executeKeywordCampaignPlan(
          factories.adsClient ? factories.adsClient() : new AdsClient(),
          plan,
          (message) => {
          process.stderr.write(`${message}\n`);
          },
        );
        return mcpResult({ account, ...launched });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  return server;
}

/** 向后兼容现有测试和调用方；新代码可使用 createAmazonMcpServer 注入两类客户端。 */
export function createAmazonAdsMcpServer(
  clientFactory: AdsClientFactory = () => new AdsClient(),
  account: string = 'default',
): McpServer {
  return createAmazonMcpServer({ adsClient: clientFactory }, account);
}

/** 从 argv 提取多店铺 MCP 的 --accounts，并在连接 Cherry 前移除。 */
export function extractAccountsArg(argv: string[]): string[] | undefined {
  const direct = argv.indexOf('--accounts');
  if (direct >= 0) {
    const value = argv[direct + 1];
    if (!value || value.startsWith('-')) throw accountsMissingValue();
    argv.splice(direct, 2);
    const accounts = parseMcpAccounts(value);
    if (accounts.length === 0) throw accountsMissingValue();
    return accounts;
  }
  const prefixed = argv.findIndex((value) => value.startsWith('--accounts='));
  if (prefixed >= 0) {
    const value = argv[prefixed]!.slice('--accounts='.length);
    if (!value) throw accountsMissingValue();
    argv.splice(prefixed, 1);
    const accounts = parseMcpAccounts(value);
    if (accounts.length === 0) throw accountsMissingValue();
    return accounts;
  }
  return undefined;
}

function accountsMissingValue(): AmzError {
  return new AmzError({
    type: 'invalid_param',
    subtype: 'mcp_accounts_missing_value',
    param: '--accounts',
    hintAgent: 'fix_param',
    hintHuman: '--accounts 后需要店铺代号列表，例如 --accounts shop-a,shop-b。',
    message: '--accounts requires a comma-separated account list',
  });
}

async function main(): Promise<void> {
  const projectDir = process.env['AMZ_CLI_PROJECT_DIR']?.trim();
  loadDotEnvIfPresent(process.env, projectDir || process.cwd());
  const account = extractAccountArg(process.argv);
  const accounts = extractAccountsArg(process.argv);
  if (account && accounts) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'mcp_account_mode_conflict',
      param: '--account/--accounts',
      hintAgent: 'fix_param',
      hintHuman: '--account（固定单店）和 --accounts（多店路由）不能同时使用。',
      message: '--account and --accounts are mutually exclusive',
    });
  }

  let server: McpServer | MultiAccountMcpRouter;
  if (accounts) {
    const serverPath = resolve(process.argv[1]!);
    server = new MultiAccountMcpRouter(accounts, {
      connector: createStdioAccountConnector({ serverPath }),
    });
  } else {
    // 账号名大小写不敏感,归一到规范名(本地=文件实际大小写)。
    const effectiveAccount = account ? loadAccount(account) : undefined;
    // MCP 写操作的审计也按店铺记账:多店路由为每个账号起 `--account` 子进程,
    // 每个子进程都走到这里,于是各自把审计归到自己的店铺(未指定则 default),
    // 不再统一记成 default(与 cli.ts 的处理一致)。
    setAuditAccount(effectiveAccount);
    server = createAmazonMcpServer({}, effectiveAccount ?? 'default');
  }
  await server.connect(new StdioServerTransport());
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;
if (isMain) {
  main().catch((error: unknown) => {
    const typed = wrapInternal(error);
    process.stderr.write(`${JSON.stringify(typed.toEnvelope())}\n`);
    process.exitCode = typed.exitCode;
  });
}
