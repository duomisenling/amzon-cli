#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { extractAccountArg, loadAccount, loadDotEnvIfPresent } from './internal/account.js';
import { AdsClient } from './internal/client/ads-client.js';
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
  type KeywordCampaignPlan,
} from './shortcuts/ads/keyword-campaign-launch.js';

const MCP_OPERATION = 'mcp launch_keyword_campaign';
const previewTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

type AdsClientFactory = () => AdsClient;

function tokenFlags(plan: KeywordCampaignPlan): Record<string, unknown> {
  return { planHash: keywordCampaignPlanHash(plan) };
}

function tokenSnapshot(plan: KeywordCampaignPlan): Record<string, unknown> {
  return { runtime: runtimeConfirmationSnapshot(), planHash: keywordCampaignPlanHash(plan) };
}

function result(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> } {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function errorResult(error: unknown): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const typed = wrapInternal(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(typed.toEnvelope(), null, 2) }],
  };
}

function writesEnabled(): boolean {
  return (process.env['AMZ_MCP_ALLOW_WRITES'] ?? '').trim().toLowerCase() === 'true';
}

/** 可注入 AdsClient，供无网络单元测试验证 MCP 数据流。 */
export function createAmazonAdsMcpServer(clientFactory: AdsClientFactory = () => new AdsClient()): McpServer {
  const server = new McpServer(
    { name: 'amz-ads-safe-launch', version: '0.1.0' },
    {
      instructions:
        'prepare_keyword_campaign 只预览。launch_keyword_campaign 会在 Amazon 创建并可能启用广告，' +
        '客户端必须对每一次调用向真人请求批准；不得在 bypassPermissions 模式使用。',
    },
  );

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
        return result({
          ...keywordCampaignPreview(plan),
          previewToken: issued.token,
          previewExpiresAt: issued.expiresAt,
          nextStep:
            '真人核对全部关键词、竞价、预算和最终启用状态后，批准 launch_keyword_campaign；任何方案变化都必须重新预览。',
        });
      } catch (error) {
        return errorResult(error);
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
        if (!writesEnabled()) {
          throw new AmzError({
            type: 'confirmation_required',
            subtype: 'mcp_writes_disabled',
            hintAgent: 'needs_human_confirm',
            hintHuman:
              'MCP 正式写入默认关闭。管理员确认 Cherry 使用 default 权限模式并会逐次弹出审批后，' +
              '才能在 MCP 进程环境中设置 AMZ_MCP_ALLOW_WRITES=true。',
            message: 'MCP writes are disabled; AMZ_MCP_ALLOW_WRITES=true is required',
          });
        }
        // Cherry 已批准本次破坏性工具调用后，才会进入 handler。令牌在首次正式执行前原子消费。
        verifyAndConsumePreviewToken(
          MCP_OPERATION,
          tokenFlags(plan),
          previewToken,
          Date.now(),
          tokenSnapshot(plan),
        );
        const launched = await executeKeywordCampaignPlan(clientFactory(), plan, (message) => {
          process.stderr.write(`${message}\n`);
        });
        return result(launched);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const projectDir = process.env['AMZ_CLI_PROJECT_DIR']?.trim();
  loadDotEnvIfPresent(process.env, projectDir || process.cwd());
  const account = extractAccountArg(process.argv);
  if (account) loadAccount(account);
  const server = createAmazonAdsMcpServer();
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
