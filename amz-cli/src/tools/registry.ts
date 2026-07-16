// 注册中枢:把所有 ToolDefinition 挂到 commander
//
// "一份定义、两处注册"的关节 —— 未来加 MCP 时在这里加第二个注册函数
// (registerMcpTools),遍历同一份定义列表,业务代码不动。
//
// 写操作门槛(规格 §8)在这里架构级强制,业务代码无法绕过:
//   mutation=none         直接执行
//   mutation=reversible   --dry-run 签发一次性令牌;执行要求令牌+交互式 y
//   mutation=irreversible --dry-run 签发一次性令牌;执行要求令牌并在交互式终端输入
//                         随机确认码(每次不同)——非 TTY(n8n/管道/Agent 自动化)
//                         一律拒绝,防止"顺手把预览和执行串进一个 workflow"
//                         (规格 §8.2 rule 2:不能只靠一个 flag)

import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { AmzError } from '../internal/errs/errors.js';
import { outSuccess, progress } from '../internal/errs/output.js';
import { SpApiClient } from '../internal/client/client.js';
import { AdsClient } from '../internal/client/ads-client.js';
import { LocalCredentialProvider } from '../internal/credential/local.js';
import { BrokerCredentialProvider, brokerConfigFromEnv } from '../internal/credential/broker.js';
import {
  issuePreviewToken,
  verifyAndConsumePreviewToken,
  verifyPreviewToken,
} from '../internal/confirmation/preview-token.js';
import { runtimeConfirmationSnapshot } from '../internal/confirmation/runtime-snapshot.js';
import type { ToolContext, ToolDefinition } from './types.js';

/**
 * 构造运行时依赖。两个 client 都是惰性单例:首次访问才解析凭证——
 * 纯广告命令不会被缺失的 SP 凭证卡住,反之亦然。
 * 凭证模式切换(业务代码无感知):
 *   .env 有 BROKER_URL → broker 模式(同事版,只有团队令牌)
 *   否则               → local 模式(开发者本机,.env 里的 refresh_token)
 */
function buildContext(flags: Record<string, unknown>): ToolContext {
  let spClient: SpApiClient | undefined;
  let adsClient: AdsClient | undefined;
  return {
    get client(): SpApiClient {
      if (!spClient) {
        const brokerCfg = brokerConfigFromEnv();
        const provider = brokerCfg
          ? new BrokerCredentialProvider(brokerCfg)
          : LocalCredentialProvider.fromEnv();
        spClient = new SpApiClient(provider);
      }
      return spClient;
    },
    get adsClient(): AdsClient {
      if (!adsClient) adsClient = new AdsClient();
      return adsClient;
    },
    flags,
    progress,
  };
}

/** 框架级 flag 校验:按 Flag.enum 统一检查(大小写不敏感)并把值规范化。 */
function validateFlags(tool: ToolDefinition, flags: Record<string, unknown>): void {
  for (const flag of tool.flags) {
    if (!flag.enum) continue;
    const key = flag.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const raw = flags[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue; // 未提供交给 required/默认值机制
    const matched = flag.enum.find((v) => v.toLowerCase() === raw.trim().toLowerCase());
    if (!matched) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_enum_value',
        param: `--${flag.name}`,
        hintAgent: 'fix_param',
        hintHuman: `--${flag.name} 的值 "${raw}" 无效。可选:${flag.enum.join(' / ')}`,
        message: `invalid value for --${flag.name}: ${raw} (allowed: ${flag.enum.join(', ')})`,
      });
    }
    flags[key] = matched; // 规范化为声明写法,业务代码无需再 toUpperCase/查枚举
  }
}

export function registerTools(program: Command, tools: ToolDefinition[]): void {
  // 按 service 分组挂一级子命令(参照 lark-cli shortcuts/register.go)
  const serviceCommands = new Map<string, Command>();

  for (const tool of tools) {
    let svc = serviceCommands.get(tool.service);
    if (!svc) {
      svc = program.command(tool.service).description(`${tool.service} 相关操作`);
      serviceCommands.set(tool.service, svc);
    }

    const cmd = svc.command(tool.command).description(tool.description);

    for (const flag of tool.flags) {
      const long = `--${flag.name}${flag.type === 'boolean' ? '' : ' <value>'}`;
      const desc = flag.enum ? `${flag.desc}(可选值:${flag.enum.join(' | ')})` : flag.desc;
      if (flag.required) {
        cmd.requiredOption(long, desc, flag.default);
      } else {
        cmd.option(long, desc, flag.default);
      }
    }

    // 写操作自动注入门槛 flag(业务定义无需也不允许自己声明)
    if (tool.mutation !== 'none') {
      cmd.option('--dry-run', '预览将要执行的修改,不实际执行');
      cmd.option('--confirm', '确认执行(必须携带预览生成的一次性令牌)');
      cmd.option('--preview-token <value>', '成功 --dry-run 后生成的短期一次性令牌');
    }

    cmd.action(async (opts: Record<string, unknown>) => {
      await runTool(tool, opts);
    });
  }
}

async function runTool(tool: ToolDefinition, flags: Record<string, unknown>): Promise<void> {
  validateFlags(tool, flags); // 框架级:enum 校验+规范化(先于业务 validate)
  if (tool.validate) tool.validate(flags);

  if (tool.requiresTty && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new AmzError({
      type: 'confirmation_required',
      subtype: 'sensitive_command_requires_tty',
      hintAgent: 'needs_human_confirm',
      hintHuman: '该命令会处理长期敏感凭证，只允许管理员本人在交互式终端运行，不能由 Agent、n8n 或管道执行。',
      message: `${tool.service} ${tool.command} handles sensitive credentials and requires an interactive terminal`,
    });
  }

  const ctx = buildContext(flags);

  // —— 写操作门槛(先于业务执行,架构级强制)——
  if (tool.mutation !== 'none') {
    if (flags['dryRun'] && flags['confirm']) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'conflicting_confirmation_flags',
        param: '--dry-run/--confirm',
        hintAgent: 'fix_param',
        hintHuman: '--dry-run 和 --confirm 不能同时使用。请先单独预览，再单独确认执行。',
        message: '--dry-run and --confirm are mutually exclusive',
      });
    }

    if (flags['dryRun']) {
      if (!tool.dryRun) {
        throw new AmzError({
          type: 'internal',
          subtype: 'missing_dry_run',
          hintAgent: 'report_to_human',
          hintHuman: '该写操作缺少预览实现,属于 CLI 的 bug,请反馈给管理员。',
          message: `${tool.service} ${tool.command} declares mutation=${tool.mutation} but has no dryRun`,
        });
      }
      const snapshotBefore = (await captureConfirmation(tool, flags, ctx)).snapshot;
      const preview = await tool.dryRun(ctx);
      const snapshotAfter = (await captureConfirmation(tool, flags, ctx)).snapshot;
      if (JSON.stringify(snapshotBefore) !== JSON.stringify(snapshotAfter)) {
        throw new AmzError({
          type: 'invalid_param',
          subtype: 'preview_input_changed',
          hintAgent: 'fix_param',
          hintHuman: '预览期间输入文件发生了变化，无法签发确认令牌。请确认文件不再修改后重新运行 --dry-run。',
          message: 'confirmation snapshot changed while dry-run was in progress',
        });
      }
      const issued = issuePreviewToken(operationName(tool), flags, Date.now(), snapshotAfter);
      outSuccess(preview, {
        dry_run: true,
        preview_token: issued.token,
        preview_expires_at: issued.expiresAt,
      });
      return;
    }

    // 所有写操作都必须显式选择预览或执行。尤其不可撤销操作不能因为
    // mutation 类型不同而绕过 --confirm，直接落入交互确认流程。
    if (!flags['confirm']) {
      throw new AmzError({
        type: 'confirmation_required',
        subtype: 'preview_first',
        hintAgent: 'needs_human_confirm',
        hintHuman: '这是写操作:请先用 --dry-run 预览改动,人工确认没问题后,再单独用 --confirm 执行。',
        message: `write operation requires --dry-run preview then --confirm; neither was given`,
      });
    }

    const previewToken = flags['previewToken'];
    if (typeof previewToken !== 'string' || previewToken.trim() === '') {
      throw new AmzError({
        type: 'confirmation_required',
        subtype: 'preview_token_required',
        param: '--preview-token',
        hintAgent: 'needs_human_confirm',
        hintHuman:
          '缺少预览令牌。请先运行 --dry-run，人工核对预览后，把输出中的 preview_token 随 --confirm 一起传入。',
        message: '--confirm requires the preview_token produced by a prior --dry-run',
      });
    }

    // dev 模式(tsx 直接跑 .ts 源码)下交互确认可能被吞,门槛不可靠 → 禁止写执行。
    // dry-run 已在上面 return,预览不受影响;只挡真正的执行。
    if (isTsxDevMode()) {
      throw new AmzError({
        type: 'confirmation_required',
        subtype: 'dev_mode_write_forbidden',
        hintAgent: 'report_to_human',
        hintHuman:
          '开发模式(用 tsx 直接跑源码)下,交互确认可能失效,已禁止执行写操作。' +
          '请用编译版:先 npm run build,再用 node dist/cli.js ... 执行(同事使用的正式版就是这样运行的)。',
        message:
          'write execution forbidden in tsx dev mode: interactive confirmation is unreliable there; use the compiled build (node dist/cli.js)',
      });
    }

    // 先要求真实终端，再校验令牌，防止普通非交互流程抢先用掉交给真人的令牌。
    assertInteractiveTerminal(tool);
    const beforeConfirmation = await captureConfirmation(tool, flags, ctx);
    verifyPreviewToken(
      operationName(tool),
      flags,
      previewToken.trim(),
      Date.now(),
      beforeConfirmation.snapshot,
    );

    // 执行时刻的操作复述(强制):--confirm 不是闷头执行,
    // 先把"正在对什么做什么"讲一遍,人和审计日志都看得到
    progress('');
    progress('━━━ 即将执行写操作 ━━━');
    progress(`  ${describeTool(tool, flags)}`);
    progress('━━━━━━━━━━━━━━━━━━━━');

    // 所有写操作的执行都必须人工在交互式终端确认(2026-07-14 项目负责人决策:
    // Agent/n8n/管道只能 dry-run,真正执行必须人自己跑并确认):
    //   reversible   → 输入 y 确认
    //   irreversible → 输入随机 6 位确认码(更强,防肌肉记忆)
    if (tool.mutation === 'irreversible') {
      await requireInteractiveConfirmation(tool, flags);
    } else {
      await requireTtyYesConfirmation(tool);
    }

    // 人工确认后重新读取一次，并把这次读取的内容同时用于哈希校验和实际执行。
    // 文件在确认提示期间被替换会令牌不匹配；校验后不再按路径重读。
    const confirmed = await captureConfirmation(tool, flags, ctx);
    verifyAndConsumePreviewToken(
      operationName(tool),
      flags,
      previewToken.trim(),
      Date.now(),
      confirmed.snapshot,
    );
    ctx.confirmedInput = confirmed.input;
  }

  const data = await tool.execute(ctx);
  outSuccess(data);
}

function operationName(tool: ToolDefinition): string {
  return `${tool.service} ${tool.command}`;
}

async function captureConfirmation(
  tool: ToolDefinition,
  flags: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ snapshot: unknown; input: unknown }> {
  const captured = tool.confirmationInput
    ? tool.confirmationInput(flags)
    : { snapshot: tool.confirmationSnapshot?.(flags), input: undefined };
  return {
    snapshot: {
      runtime: runtimeConfirmationSnapshot(),
      remoteIdentity: tool.confirmationRuntimeSnapshot
        ? await tool.confirmationRuntimeSnapshot(ctx)
        : undefined,
      commandInput: captured.snapshot,
    },
    input: captured.input,
  };
}

/**
 * 是否 tsx 开发模式(直接跑 .ts 源码)。此模式下交互确认可能被 tsx 吞掉,
 * 写操作门槛不可靠——用运行入口是否为 .ts/.mts 判断(编译版是 dist/*.js)。
 */
function isTsxDevMode(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('.ts') || entry.endsWith('.mts');
}

/** 断言当前在交互式终端;否则以类型化错误拒绝(写操作禁止自动化执行)。 */
function assertInteractiveTerminal(tool: ToolDefinition): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new AmzError({
      type: 'confirmation_required',
      subtype: 'interactive_terminal_required',
      hintAgent: 'needs_human_confirm',
      hintHuman:
        '写操作禁止在自动化流程(Agent/n8n/管道)中执行。' +
        '请把这条命令交给使用者本人,在 PowerShell 终端里手动运行并按提示确认。' +
        'Agent 能做的到 --dry-run 预览为止。',
      message: `${tool.service} ${tool.command} is a write operation: interactive TTY confirmation required, non-TTY execution is forbidden by design`,
    });
  }
}

/** reversible 写操作的执行确认:TTY 里输入 y 才执行。 */
async function requireTtyYesConfirmation(tool: ToolDefinition): Promise<void> {
  assertInteractiveTerminal(tool);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question('   确认执行以上操作?输入 y 执行,其他任意输入取消 > ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    throw new AmzError({
      type: 'confirmation_required',
      subtype: 'user_cancelled',
      hintAgent: 'needs_human_confirm',
      hintHuman: '已取消,未执行任何修改。',
      message: 'user declined interactive confirmation; nothing executed',
    });
  }
  process.stderr.write('   已确认,开始执行...\n');
}

/** 操作的人话描述:优先用命令自带的 describe,否则回退为命令名+参数摘要。 */
function describeTool(tool: ToolDefinition, flags: Record<string, unknown>): string {
  if (tool.describe) return tool.describe(flags);
  const shown = Object.entries(flags)
    .filter(
      ([k, v]) =>
        v !== undefined && k !== 'confirm' && k !== 'dryRun' && k !== 'previewToken',
    )
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  return `${tool.service} ${tool.command} ${shown}`;
}

/**
 * 不可撤销操作的交互式确认(规格 §8.2 rule 2)。
 * 设计要点:
 *   1. 必须是交互式终端(TTY)——n8n / 管道 / Agent 子进程没有 TTY,直接拒绝,
 *      从机制上杜绝"预览和执行被串进同一条自动化流程"。
 *   2. 确认码每次随机生成——无法脚本硬编码,也无法由 Agent 预先注入。
 */
async function requireInteractiveConfirmation(
  tool: ToolDefinition,
  flags: Record<string, unknown>,
): Promise<void> {
  assertInteractiveTerminal(tool);

  const code = String(randomInt(100000, 999999));
  process.stderr.write(
    `\n⚠️  不可撤销操作,请再次核对:\n` +
      `   ${describeTool(tool, flags)}\n` +
      `   此操作执行后无法回退(如 Feed 提交后无法撤回)。\n` +
      `   确认执行请输入以下 6 位确认码,直接回车则取消:\n\n   确认码:${code}\n\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question('   请输入确认码 > ')).trim();
  rl.close();

  if (answer !== code) {
    throw new AmzError({
      type: 'confirmation_required',
      subtype: 'confirmation_code_mismatch',
      hintAgent: 'needs_human_confirm',
      hintHuman: '确认码不匹配,操作已取消(未执行任何修改)。',
      message: 'interactive confirmation code mismatch; operation aborted, nothing executed',
    });
  }
  process.stderr.write('   确认码正确,开始执行...\n');
}
