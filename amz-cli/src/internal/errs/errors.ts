// 错误契约(规格 §6)——单一事实来源
//
// 设计参照 lark-cli 的 errs/ERROR_CONTRACT.md:
//   - 每个错误恰好属于一个 type(封闭集合)
//   - type + subtype 是稳定标识,Agent 可以安全地据此分支
//   - exit code 由 type 派生,不允许调用点自定
//   - hint_agent 给 Agent 自动决策;hint_human 给非技术同事看的中文人话

/** 错误大类(封闭集合,规格 §6.2)。新增成员需要 review。 */
type ErrorType =
  | 'invalid_param' // 参数错误(用户/Agent 传错了)
  | 'auth_expired' // 凭证过期或无效
  | 'insufficient_scope' // 凭证有效但角色/权限不够
  | 'rate_limited' // 限流,重试耗尽后仍失败
  | 'upstream_error' // 亚马逊侧错误(5xx / 网络故障)
  | 'confirmation_required' // 写操作需要确认门槛
  | 'internal'; // CLI 自身 bug(规格枚举外的必要补充:内部错误必须有去处)

/** Agent 决策提示(规格 §6.2)。 */
type AgentHint =
  | 'fix_param' // 修正参数后重试
  | 'reauthorize' // 需要重新授权,找管理员
  | 'backoff_and_retry' // 等待后重试
  | 'needs_human_confirm' // 需要人工确认,不得自动继续
  | 'report_to_human'; // 无法自动处理,如实报给人

/** exit code 由 type 派生(参照 lark-cli ExitCodeForCategory 的做法)。 */
const EXIT_CODES: Record<ErrorType, number> = {
  invalid_param: 2,
  auth_expired: 3,
  insufficient_scope: 3,
  rate_limited: 4,
  upstream_error: 1,
  confirmation_required: 10,
  internal: 5,
};

interface AmzErrorOptions {
  type: ErrorType;
  /** 稳定子类型,lowercase_with_underscores,如 "sp_api.throttled" */
  subtype: string;
  /** 触发错误的具体参数(如 "--asin"),没有则省略 */
  param?: string;
  hintAgent: AgentHint;
  /** 中文人话,让不懂技术的同事不需要把报错发给别人解读 */
  hintHuman: string;
  /** 技术细节(英文原始报错等),给排查用 */
  message: string;
  /** 上游 HTTP 状态码(如有) */
  status?: number;
  /** 是否可以安全重试 */
  retryable?: boolean;
  cause?: unknown;
}

/** CLI 的类型化错误。所有错误路径都应构造它(或被顶层包装成 internal)。 */
export class AmzError extends Error {
  readonly type: ErrorType;
  readonly subtype: string;
  readonly param?: string;
  readonly hintAgent: AgentHint;
  readonly hintHuman: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(opts: AmzErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AmzError';
    this.type = opts.type;
    this.subtype = opts.subtype;
    this.param = opts.param;
    this.hintAgent = opts.hintAgent;
    this.hintHuman = opts.hintHuman;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }

  get exitCode(): number {
    return EXIT_CODES[this.type];
  }

  /** stderr 错误 envelope(规格 §6.2 的结构)。 */
  toEnvelope(): Record<string, unknown> {
    return {
      ok: false,
      error: {
        type: this.type,
        subtype: this.subtype,
        ...(this.param ? { param: this.param } : {}),
        hint_agent: this.hintAgent,
        hint_human: this.hintHuman,
        message: this.message,
        ...(this.status !== undefined ? { status: this.status } : {}),
        ...(this.retryable ? { retryable: true } : {}),
      },
    };
  }
}

/** 把任意未知错误提升为 internal AmzError;已是 AmzError 则原样返回(幂等)。 */
export function wrapInternal(err: unknown): AmzError {
  if (err instanceof AmzError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AmzError({
    type: 'internal',
    subtype: 'unexpected_error',
    hintAgent: 'report_to_human',
    hintHuman: 'CLI 内部出错了,请把完整报错信息发给管理员排查。',
    message,
    cause: err,
  });
}
