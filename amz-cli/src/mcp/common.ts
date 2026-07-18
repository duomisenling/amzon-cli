import { z } from 'zod';
import { AmzError, wrapInternal } from '../internal/errs/errors.js';

export const previewTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function mcpResult(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

export function mcpErrorResult(error: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const typed = wrapInternal(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(typed.toEnvelope(), null, 2) }],
  };
}

const LEGACY_DEFAULT_OPERATION = 'ads.keyword-campaign-launch';

/**
 * 解析操作白名单。语义区分"未设置"和"显式为空":
 *   - 未设置        → 兼容 0.1.0 已有安装,只开放原有完整关键词广告工具
 *   - 设置为空/空白 → 管理员显式吊销全部,返回空集合(拒绝所有写入)
 */
function allowedOperations(): { allowed: Set<string>; explicitlyEmpty: boolean } {
  const raw = process.env['AMZ_MCP_ALLOWED_WRITES'];
  if (raw === undefined) {
    return { allowed: new Set([LEGACY_DEFAULT_OPERATION]), explicitlyEmpty: false };
  }
  const allowed = new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return { allowed, explicitlyEmpty: allowed.size === 0 };
}

/**
 * MCP 写入同时受总开关和操作白名单约束。
 */
export function assertMcpWriteAllowed(operation: string): void {
  const enabled = (process.env['AMZ_MCP_ALLOW_WRITES'] ?? '').trim().toLowerCase() === 'true';
  if (!enabled) {
    throw new AmzError({
      type: 'confirmation_required',
      subtype: 'mcp_writes_disabled',
      hintAgent: 'needs_human_confirm',
      hintHuman:
        'MCP 正式写入默认关闭。管理员确认 Cherry 使用逐次审批且未启用 bypassPermissions 后，' +
        '才能在 MCP 进程环境中设置 AMZ_MCP_ALLOW_WRITES=true。',
      message: 'MCP writes are disabled; AMZ_MCP_ALLOW_WRITES=true is required',
    });
  }

  const { allowed, explicitlyEmpty } = allowedOperations();
  if (!allowed.has('*') && !allowed.has(operation.toLowerCase())) {
    throw new AmzError({
      type: 'insufficient_scope',
      subtype: 'mcp_write_not_allowed',
      hintAgent: 'report_to_human',
      hintHuman: explicitlyEmpty
        ? `AMZ_MCP_ALLOWED_WRITES 被显式设置为空,当前 MCP 服务拒绝全部正式写入(含 ${operation})。`
        : `管理员没有为当前 MCP 服务开放写操作 ${operation}。` +
          '请核对 AMZ_MCP_ALLOWED_WRITES；不要让 Agent 自行扩大权限。',
      message: `MCP write operation is not allowed: ${operation}`,
    });
  }
}

/**
 * 非抛错的写权限查询,供 prepare 在预览响应里预告 apply 是否会被放行,
 * 避免运营走完一轮审批才发现令牌无法兑现。
 */
export function mcpApplyPermission(
  operation: string,
): { allowed: true } | { allowed: false; reason: string } {
  try {
    assertMcpWriteAllowed(operation);
    return { allowed: true };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof AmzError ? error.hintHuman : String(error),
    };
  }
}
