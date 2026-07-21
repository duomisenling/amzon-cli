#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractAccountArg, loadAccount, loadDotEnvIfPresent } from './internal/account.js';
import { AdsClient } from './internal/client/ads-client.js';
import type { SpApiClient } from './internal/client/client.js';
import {
  issuePreviewToken,
  verifyAndConsumePreviewToken,
} from './internal/confirmation/preview-token.js';
import { runtimeConfirmationSnapshot } from './internal/confirmation/runtime-snapshot.js';
import { wrapInternal } from './internal/errs/errors.js';
import {
  executeKeywordCampaignPlan,
  keywordCampaignPlanHash,
  keywordCampaignPlanSchema,
  keywordCampaignPreview,
  type KeywordCampaignPlan,
} from './shortcuts/ads/keyword-campaign-launch.js';
import type { ToolClientFactories } from './tools/context.js';
import {
  assertMcpWriteAllowed,
  mcpApplyPermission,
  mcpErrorResult,
  mcpResult,
  previewTokenSchema,
} from './mcp/common.js';
import { registerOperationalWriteTools } from './mcp/write-tools.js';

const MCP_OPERATION = 'mcp launch_keyword_campaign';
const KEYWORD_CAMPAIGN_PERMISSION = 'ads.keyword-campaign-launch';

type AdsClientFactory = () => AdsClient;

function tokenFlags(plan: KeywordCampaignPlan): Record<string, unknown> {
  return { planHash: keywordCampaignPlanHash(plan) };
}

function tokenSnapshot(plan: KeywordCampaignPlan): Record<string, unknown> {
  return { runtime: runtimeConfirmationSnapshot(), planHash: keywordCampaignPlanHash(plan) };
}

export interface AmazonMcpClientFactories extends ToolClientFactories {
  spClient?: () => SpApiClient;
  adsClient?: () => AdsClient;
}

/** 可注入客户端，供无网络单元测试验证 MCP 数据流。 */
export function createAmazonMcpServer(factories: AmazonMcpClientFactories = {}): McpServer {
  const server = new McpServer(
    { name: 'amz-cli-safe-writes', version: '0.2.4' },
    {
      instructions:
        '所有 prepare_* 工具只预览；apply_* 和 launch_keyword_campaign 会正式写入 Amazon。' +
        '客户端必须对每一次正式写工具调用向真人请求批准，不得自动批准或使用 bypassPermissions。',
    },
  );

  registerOperationalWriteTools(server, factories);

  server.registerTool(
    'prepare_keyword_campaign',
    {
      title: '预览完整关键词广告',
      description:
        '只做本地参数校验和预览，不调用 Amazon 写接口。返回绑定完整方案和运行环境、15 分钟有效的一次性 previewToken。',
      inputSchema: { plan: keywordCampaignPlanSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ plan }) => {
      try {
        const issued = issuePreviewToken(MCP_OPERATION, tokenFlags(plan), Date.now(), tokenSnapshot(plan));
        // 与 write-tools 的 prepare_* 一致:预览永远可做,但预告 launch 会不会被放行
        const permission = mcpApplyPermission(KEYWORD_CAMPAIGN_PERMISSION);
        return mcpResult({
          ...keywordCampaignPreview(plan),
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
      title: '创建并启动完整关键词广告',
      description:
        '高风险写操作：消费 prepare 返回的一次性令牌，在 Amazon 创建 Campaign、广告组、商品广告和关键词；' +
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
        // Cherry 已批准本次破坏性工具调用后，才会进入 handler。令牌在首次正式执行前原子消费。
        verifyAndConsumePreviewToken(
          MCP_OPERATION,
          tokenFlags(plan),
          previewToken,
          Date.now(),
          tokenSnapshot(plan),
        );
        const launched = await executeKeywordCampaignPlan(
          factories.adsClient ? factories.adsClient() : new AdsClient(),
          plan,
          (message) => {
          process.stderr.write(`${message}\n`);
          },
        );
        return mcpResult(launched);
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  return server;
}

/** 向后兼容现有测试和调用方；新代码可使用 createAmazonMcpServer 注入两类客户端。 */
export function createAmazonAdsMcpServer(clientFactory: AdsClientFactory = () => new AdsClient()): McpServer {
  return createAmazonMcpServer({ adsClient: clientFactory });
}

async function main(): Promise<void> {
  const projectDir = process.env['AMZ_CLI_PROJECT_DIR']?.trim();
  loadDotEnvIfPresent(process.env, projectDir || process.cwd());
  const account = extractAccountArg(process.argv);
  if (account) loadAccount(account);
  const server = createAmazonMcpServer();
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
