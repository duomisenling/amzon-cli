// Tool Definition Layer(规格 §4 核心:一份定义、两处注册)
//
// 一个功能 = 一个 ToolDefinition 对象(放在 src/shortcuts/<域>/ 下)。
// registry.ts 把它注册成 CLI 命令;未来加 MCP 时,同一份定义再注册成 MCP 工具,
// 业务代码零改动。
//
// 参照 lark-cli 的 shortcuts/common/types.go(Shortcut struct)。

import type { ZodSchema } from 'zod';
import type { SpApiClient } from '../internal/client/client.js';
import type { AdsClient } from '../internal/client/ads-client.js';

export interface Flag {
  /** flag 名(kebab-case,如 "marketplace") */
  name: string;
  type?: 'string' | 'boolean' | 'number';
  desc: string;
  required?: boolean;
  /** 默认值,由框架传给 commander(数字默认值以字符串形式声明,如 '30') */
  default?: string | boolean;
  /**
   * 允许的取值(单值 flag 用)。registry 统一校验:大小写不敏感,
   * 校验通过后把值规范化为这里声明的写法——业务代码无需再查枚举。
   * 逗号分隔的多值 flag 不要用此字段(在 validate 里自行校验)。
   */
  enum?: string[];
}

export interface ToolContext {
  /** SP-API client(惰性构造:首次访问才解析凭证,纯广告命令不会被 SP 凭证卡住) */
  client: SpApiClient;
  /** 广告 API client(惰性单例,ads 域命令用) */
  adsClient: AdsClient;
  /** 解析后的 flag 值 */
  flags: Record<string, unknown>;
  /** 人工确认后已校验并冻结的执行输入；文件型写操作必须使用它，不能重新读路径。 */
  confirmedInput?: unknown;
  /** 进度输出(走 stderr,不污染 stdout 数据) */
  progress: (msg: string) => void;
}

export interface ToolDefinition {
  /** 业务域,即一级子命令(listing / orders / report / pricing / feedback / auth) */
  service: string;
  /** 命令名,即二级子命令(如 "search") */
  command: string;
  description: string;
  /**
   * 写操作级别(规格 §8.1),决定门槛:
   *   none         —— 只读,直接执行
   *   reversible   —— 可改回去的写操作:必须 --dry-run 预览 → 人看过 → --confirm 执行
   *   irreversible —— 不可撤销:除预览令牌外还要求在真实终端输入随机确认码
   */
  mutation: 'none' | 'reversible' | 'irreversible';
  /** 含长期凭证等敏感结果的管理员命令，禁止在非交互式 Agent/流水线中运行。 */
  requiresTty?: boolean;
  flags: Flag[];
  /** 元数据:Report/Feed 类异步操作标记(当前仅自描述用途,框架不消费) */
  isAsync?: boolean;
  /** 元数据:该功能需要的 SP-API 角色(仅文档用途,便于排查 403,框架不消费) */
  roles?: string[];
  /** 预留:MCP 阶段用作工具参数 schema(规格 §4);当前框架不消费,校验走 validate */
  schema?: ZodSchema;
  /** 参数校验钩子:抛 AmzError 拒绝执行 */
  validate?: (flags: Record<string, unknown>) => void;
  /**
   * 人话操作描述(写操作必备):一句话说清"将对什么做什么"。
   * 框架在 --confirm 执行前和 irreversible 交互确认时强制展示,
   * 让执行时刻的人再看一遍自己在做什么。
   */
  describe?: (flags: Record<string, unknown>) => string;
  /** 预览钩子:mutation != 'none' 时必须提供;返回值会作为预览数据输出 */
  dryRun?: (ctx: ToolContext) => Promise<unknown>;
  /**
   * 影响实际写入、但不能只靠 flag 字符串表达的输入快照(例如文件内容哈希)。
   * 框架会把它绑定进预览令牌，并在确认时重新计算后比较。
   */
  confirmationSnapshot?: (flags: Record<string, unknown>) => unknown;
  /**
   * 一次读取同时生成确认快照和不可变执行输入，用于消除“校验后替换文件”的竞态。
   * 若提供，优先于 confirmationSnapshot。
   */
  confirmationInput?: (flags: Record<string, unknown>) => { snapshot: unknown; input: unknown };
  /** 主逻辑:返回值 = stdout 的 data 字段(业务代码不直接写 stdout) */
  execute: (ctx: ToolContext) => Promise<unknown>;
}
