import { canonicalize } from '../internal/confirmation/preview-token.js';
import { runtimeConfirmationSnapshot } from '../internal/confirmation/runtime-snapshot.js';
import type { ToolContext, ToolDefinition } from './types.js';

export interface ConfirmationCapture {
  snapshot: {
    runtime: Record<string, unknown>;
    remoteIdentity?: unknown;
    remoteState?: unknown;
    commandInput?: unknown;
  };
  input: unknown;
}

/** 生成 CLI/MCP 共用的确认快照，并同时冻结文件型执行输入。 */
export async function captureConfirmation(
  tool: ToolDefinition,
  flags: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ConfirmationCapture> {
  const captured = tool.confirmationInput
    ? tool.confirmationInput(flags)
    : { snapshot: tool.confirmationSnapshot?.(flags), input: undefined };
  return {
    snapshot: {
      runtime: runtimeConfirmationSnapshot(),
      remoteIdentity: tool.confirmationRuntimeSnapshot
        ? await tool.confirmationRuntimeSnapshot(ctx)
        : undefined,
      remoteState: tool.confirmationStateSnapshot
        ? await tool.confirmationStateSnapshot(ctx)
        : undefined,
      commandInput: captured.snapshot,
    },
    input: captured.input,
  };
}

export function sameConfirmationSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

/**
 * 令牌校验通过后,把冻结的执行输入和门禁读到的远端状态一并交给 execute。
 * CLI 与 MCP 的确认流水线都必须走这里,防止两条路径对 ctx 的填充各自漂移。
 */
export function applyConfirmedCapture(ctx: ToolContext, capture: ConfirmationCapture): void {
  ctx.confirmedInput = capture.input;
  ctx.confirmationState = capture.snapshot.remoteState;
}
