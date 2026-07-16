// 输出规范(规格 §6.1):
//   stdout —— 只输出成功结果的纯 JSON,无任何日志/进度/提示文字
//   stderr —— 结构化错误 JSON + 进度信息
// 两者严格分离,避免管道污染。业务代码不得直接 console.log。

import { AmzError, wrapInternal } from './errors.js';

/** 成功结果 → stdout(唯一允许写 stdout 的出口)。 */
export function outSuccess(data: unknown, meta?: Record<string, unknown>): void {
  const envelope = { ok: true, data, ...(meta ? { meta } : {}) };
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
}

/** 进度/提示 → stderr(人和 Agent 的日志通道,不污染数据)。 */
export function progress(msg: string): void {
  process.stderr.write(msg + '\n');
}

/** 错误 envelope → stderr,并返回应使用的 exit code。 */
export function printError(err: unknown): number {
  const amzErr = err instanceof AmzError ? err : wrapInternal(err);
  process.stderr.write(JSON.stringify(amzErr.toEnvelope(), null, 2) + '\n');
  return amzErr.exitCode;
}
