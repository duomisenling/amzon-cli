import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  issuePreviewToken,
  verifyAndConsumePreviewToken,
} from '../internal/confirmation/preview-token.js';
import { AmzError } from '../internal/errs/errors.js';
import { adsCampaignBudget } from '../shortcuts/ads/campaign-budget.js';
import { adsCampaignCreate } from '../shortcuts/ads/campaign-create.js';
import { adsCampaignState } from '../shortcuts/ads/campaign-state.js';
import { adsKeywordBid, adsNegativeKeyword } from '../shortcuts/ads/keywords.js';
import { feedSubmit } from '../shortcuts/feed/commands.js';
import { listingUpdate } from '../shortcuts/listing/update.js';
import {
  applyConfirmedCapture,
  captureConfirmation,
  sameConfirmationSnapshot,
} from '../tools/confirmation.js';
import { buildToolContext, type ToolClientFactories } from '../tools/context.js';
import type { ToolDefinition } from '../tools/types.js';
import {
  assertMcpWriteAllowed,
  mcpApplyPermission,
  mcpErrorResult,
  mcpResult,
  previewTokenSchema,
} from './common.js';

type RawShape = Record<string, z.ZodTypeAny>;

interface WriteRegistration {
  operation: string;
  prepareName: string;
  applyName: string;
  prepareTitle: string;
  applyTitle: string;
  description: string;
  tool: ToolDefinition;
  inputShape: RawShape;
  toFlags: (args: Record<string, unknown>) => Record<string, unknown>;
  prepareOpenWorld: boolean;
}

const nonEmpty = z.string().trim().min(1);
const numericId = z.string().regex(/^\d+$/);
const region = z.enum(['na', 'eu', 'fe']).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const patchSchema = z.object({
  op: z.enum(['add', 'replace', 'merge', 'delete']),
  path: nonEmpty,
  value: z.array(z.record(z.unknown())).optional(),
}).strict();

function strings(args: Record<string, unknown>, numericKeys: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    out[key] = numericKeys.includes(key) ? String(value) : value;
  }
  return out;
}

const registrations: WriteRegistration[] = [
  {
    operation: 'listing.update',
    prepareName: 'prepare_listing_update',
    applyName: 'apply_listing_update',
    prepareTitle: '预览 Listing 修改',
    applyTitle: '执行 Listing 修改',
    description: '修改单个 SKU 的 Listing 属性；预览会调用 Amazon VALIDATION_PREVIEW，但不会落库。',
    tool: listingUpdate,
    inputShape: {
      marketplace: nonEmpty,
      sku: nonEmpty,
      sellerId: nonEmpty.optional(),
      productType: nonEmpty,
      patches: z.array(patchSchema).min(1),
    },
    toFlags: (args) => ({
      marketplace: args['marketplace'],
      sku: args['sku'],
      sellerId: args['sellerId'],
      productType: args['productType'],
      patches: JSON.stringify(args['patches']),
    }),
    prepareOpenWorld: true,
  },
  {
    operation: 'feed.submit',
    prepareName: 'prepare_feed_submit',
    applyName: 'apply_feed_submit',
    prepareTitle: '预览 Feed 批量提交',
    applyTitle: '提交 Feed 批量修改',
    description: '提交 TSV Feed；处理完成后不可撤回，审批前会绑定文件内容哈希。',
    tool: feedSubmit,
    inputShape: { marketplace: nonEmpty, type: nonEmpty, file: nonEmpty },
    toFlags: (args) => ({ marketplace: args['marketplace'], type: args['type'], file: args['file'] }),
    prepareOpenWorld: false,
  },
  {
    operation: 'ads.campaign-create',
    prepareName: 'prepare_ads_campaign_create',
    applyName: 'apply_ads_campaign_create',
    prepareTitle: '预览广告活动创建',
    applyTitle: '创建广告活动',
    description: '创建 Sponsored Products Campaign；默认 PAUSED，显式 ENABLED 会开始投放。',
    tool: adsCampaignCreate,
    inputShape: {
      profileId: numericId,
      region,
      name: nonEmpty,
      targetingType: z.enum(['MANUAL', 'AUTO']),
      dailyBudget: z.number().positive(),
      start: date,
      end: date.optional(),
      state: z.enum(['PAUSED', 'ENABLED']).optional(),
    },
    toFlags: (args) => strings(args, ['dailyBudget']),
    prepareOpenWorld: false,
  },
  {
    operation: 'ads.campaign-state',
    prepareName: 'prepare_ads_campaign_state',
    applyName: 'apply_ads_campaign_state',
    prepareTitle: '预览广告启用或暂停',
    applyTitle: '启用或暂停广告',
    description: '将 Campaign 切换为 ENABLED 或 PAUSED；启用后会开始产生广告花费。',
    tool: adsCampaignState,
    inputShape: {
      profileId: numericId,
      region,
      campaignId: numericId,
      state: z.enum(['ENABLED', 'PAUSED']),
    },
    toFlags: strings,
    prepareOpenWorld: true,
  },
  {
    operation: 'ads.campaign-budget',
    prepareName: 'prepare_ads_campaign_budget',
    applyName: 'apply_ads_campaign_budget',
    prepareTitle: '预览广告预算修改',
    applyTitle: '修改广告预算',
    description: '修改 Campaign 日预算；预览和执行前都会核对当前预算。',
    tool: adsCampaignBudget,
    inputShape: {
      profileId: numericId,
      region,
      campaignId: numericId,
      dailyBudget: z.number().positive(),
    },
    toFlags: (args) => strings(args, ['dailyBudget']),
    prepareOpenWorld: true,
  },
  {
    operation: 'ads.keyword-bid',
    prepareName: 'prepare_ads_keyword_bid',
    applyName: 'apply_ads_keyword_bid',
    prepareTitle: '预览关键词竞价修改',
    applyTitle: '修改关键词竞价',
    description: '修改单个关键词竞价；预览和执行前都会核对当前关键词状态。',
    tool: adsKeywordBid,
    inputShape: {
      profileId: numericId,
      region,
      keywordId: numericId,
      bid: z.number().positive(),
    },
    toFlags: (args) => strings(args, ['bid']),
    prepareOpenWorld: true,
  },
  {
    operation: 'ads.negative-keyword',
    prepareName: 'prepare_ads_negative_keyword',
    applyName: 'apply_ads_negative_keyword',
    prepareTitle: '预览添加否定关键词',
    applyTitle: '添加否定关键词',
    description: '向广告组添加否定关键词；当前仅以 Amazon 创建响应确认结果。',
    tool: adsNegativeKeyword,
    inputShape: {
      profileId: numericId,
      region,
      campaignId: numericId,
      adGroupId: numericId,
      text: nonEmpty,
      match: z.enum(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE']).optional(),
    },
    toFlags: strings,
    prepareOpenWorld: false,
  },
];

function tokenOperation(operation: string): string {
  return `mcp ${operation}`;
}

function ensureDryRun(tool: ToolDefinition): NonNullable<ToolDefinition['dryRun']> {
  if (!tool.dryRun) {
    throw new AmzError({
      type: 'internal',
      subtype: 'missing_dry_run',
      hintAgent: 'report_to_human',
      hintHuman: '该 MCP 写操作缺少预览实现，已拒绝执行。',
      message: `${tool.service} ${tool.command} has no dryRun implementation`,
    });
  }
  return tool.dryRun;
}

export function registerOperationalWriteTools(
  server: McpServer,
  factories: ToolClientFactories = {},
): void {
  for (const registration of registrations) {
    server.registerTool(
      registration.prepareName,
      {
        title: registration.prepareTitle,
        description:
          `${registration.description} 只预览并签发 15 分钟一次性令牌；` +
          '输入、账户、区域或远端当前状态变化后必须重新预览。',
        inputSchema: registration.inputShape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: registration.prepareOpenWorld,
        },
      },
      async (args) => {
        try {
          const flags = registration.toFlags(args as Record<string, unknown>);
          registration.tool.validate?.(flags);
          const ctx = buildToolContext(flags, factories);
          const before = await captureConfirmation(registration.tool, flags, ctx);
          ctx.confirmationState = before.snapshot.remoteState;
          const preview = await ensureDryRun(registration.tool)(ctx);
          const after = await captureConfirmation(registration.tool, flags, ctx);
          if (!sameConfirmationSnapshot(before.snapshot, after.snapshot)) {
            throw new AmzError({
              type: 'invalid_param',
              subtype: 'preview_input_changed',
              hintAgent: 'fix_param',
              hintHuman: '预览期间输入文件、账户或远端当前状态发生变化，请重新预览。',
              message: `confirmation state changed while preparing ${registration.operation}`,
            });
          }
          const issued = issuePreviewToken(
            tokenOperation(registration.operation),
            flags,
            Date.now(),
            after.snapshot,
          );
          // 预览永远可做(这正是让 Agent 安全预览的目标),但要预告 apply 会不会被
          // 当前环境放行,避免运营走完一轮审批才发现令牌兑不了现。
          const permission = mcpApplyPermission(registration.operation);
          return mcpResult({
            operation: registration.operation,
            preview,
            previewToken: issued.token,
            previewExpiresAt: issued.expiresAt,
            applyAllowed: permission.allowed,
            ...(permission.allowed ? {} : { applyBlockedReason: permission.reason }),
            nextStep: permission.allowed
              ? `真人核对后，在 Cherry 审批 ${registration.applyName}；任何参数变化都必须重新预览。`
              : `当前环境未放行 ${registration.applyName} 的正式写入，本令牌无法兑现。` +
                '如需执行，请联系管理员调整 MCP 写入配置后重新预览，或由人工在 CLI 里重新预览并执行。',
          });
        } catch (error) {
          return mcpErrorResult(error);
        }
      },
    );

    server.registerTool(
      registration.applyName,
      {
        title: registration.applyTitle,
        description:
          `${registration.description} 正式写入 Amazon；` +
          '必须由 Cherry 对本次工具调用逐次弹出真人审批，不得自动批准。',
        inputSchema: { ...registration.inputShape, previewToken: previewTokenSchema },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          assertMcpWriteAllowed(registration.operation);
          const { previewToken, ...businessArgs } = args as Record<string, unknown>;
          const flags = registration.toFlags(businessArgs);
          registration.tool.validate?.(flags);
          const ctx = buildToolContext(flags, factories);
          const confirmed = await captureConfirmation(registration.tool, flags, ctx);
          verifyAndConsumePreviewToken(
            tokenOperation(registration.operation),
            flags,
            String(previewToken),
            Date.now(),
            confirmed.snapshot,
          );
          applyConfirmedCapture(ctx, confirmed);
          const executed = await registration.tool.execute(ctx);
          return mcpResult({ operation: registration.operation, executed });
        } catch (error) {
          return mcpErrorResult(error);
        }
      },
    );
  }
}
