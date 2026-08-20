import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AmzError } from '../internal/errs/errors.js';
import type { PackageInfo } from '../internal/package-info.js';
import { initUserConfig, userConfigPath } from './config.js';

interface NpmTooling {
  npmCli: string;
  npxCli: string;
}

export interface InstallPlan {
  package: string;
  commands: string[][];
  configPath: string;
  effects: string[];
}

interface InstallOptions {
  dryRun?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  tooling?: NpmTooling;
  runNpm?: (args: string[], capture?: boolean) => string;
  runNpx?: (args: string[]) => void;
  initConfig?: () => { path: string; created: boolean };
}

/**
 * 列出已安装全局包里随包分发的 Skill 目录(含 SKILL.md 的直接子目录),按名字排序。
 * 目录不存在或读不了时返回空数组,由调用方按"包损坏"处理。
 */
function packagedSkillPaths(globalPackageRoot: string): string[] {
  const skillsRoot = join(globalPackageRoot, 'skills');
  if (!existsSync(skillsRoot)) return [];
  let entries;
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsRoot, entry.name))
    .filter((path) => existsSync(join(path, 'SKILL.md')))
    .sort();
}

export function createInstallPlan(info: PackageInfo, home?: string): InstallPlan {
  // 必须装 @latest 而不是当前运行版本:从旧版 CLI 跑 amz-cli install 时,
  // info.version 是旧版号,按它装等于"永远装回旧版",升级就失效了。
  const spec = `${info.name}@latest`;
  return {
    package: spec,
    commands: [
      ['npm', 'install', '--global', spec],
      [
        'npx',
        '--yes',
        'skills',
        'add',
        `<npm-global-root>/${info.name}/skills/<每个随包 Skill>`,
        '--yes',
        '--global',
      ],
    ],
    configPath: userConfigPath(home),
    effects: [
      '安装或升级全局 amz-cli 与 amz-cli-mcp 命令到 npm 最新版',
      '安装与新装全局包同版本的全部 Agent Skill(从新装的全局包目录读取)',
      '首次安装时创建不含真实凭证的用户配置模板；已有配置绝不覆盖',
    ],
  };
}

export function installAmzCli(info: PackageInfo, options: InstallOptions = {}): {
  dryRun: boolean;
  plan: InstallPlan;
  globalPackageRoot?: string;
  config?: { path: string; created: boolean };
} {
  const plan = createInstallPlan(info, options.home);
  if (options.dryRun) return { dryRun: true, plan };

  try {
    const tooling = options.tooling ?? resolveNpmTooling(options.env, options.execPath);
    const runNpm =
      options.runNpm ??
      ((args: string[], capture = false) =>
        runNodeCli(tooling.npmCli, args, capture, options.env, options.execPath));
    const runNpx =
      options.runNpx ??
      ((args: string[]) => {
        runNodeCli(tooling.npxCli, args, false, options.env, options.execPath);
      });

    runNpm(['install', '--global', plan.package]);
    // Skill 从"刚装好的全局包目录"读取,而不是当前运行的包:保证升级后装的是新版 Skill。
    const globalRoot = runNpm(['root', '--global'], true).trim();
    const globalPackageRoot = join(globalRoot, ...info.name.split('/'));
    // 装随包分发的**全部** Skill,不只 amz-cli:新增 Skill 只要进了 package.json 的
    // files 就会被这里发现,不用再改安装逻辑。amz-cli 本体缺失仍视为包损坏。
    const skillPaths = packagedSkillPaths(globalPackageRoot);
    const corePath = join(globalPackageRoot, 'skills', 'amz-cli');
    if (!skillPaths.includes(corePath)) {
      throw new Error(`installed package is missing Skill: ${corePath}`);
    }
    for (const skillPath of skillPaths) {
      runNpx(['--yes', 'skills', 'add', skillPath, '--yes', '--global']);
    }

    const config = options.initConfig
      ? options.initConfig()
      : initUserConfig(options.home);
    return { dryRun: false, plan, globalPackageRoot, config };
  } catch (error) {
    throw new AmzError({
      type: 'internal',
      subtype: 'setup.install_failed',
      hintAgent: 'report_to_human',
      hintHuman:
        `安装没有完成。请保留报错并让管理员排查；不要删除现有配置。` +
        `可分别重试: npm install -g ${plan.package}，然后重新运行 amz-cli install。`,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

export function resolveNpmTooling(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): NpmTooling {
  // npm_execpath 不一定是 npm:经 pnpm/yarn 调起时它指向 pnpm.cjs / yarn.js,
  // 旁边没有 npx-cli.js,硬用会直接失败。只有文件名以 "npm" 开头(npm-cli.js 等)
  // 才采信,否则忽略,回退到 Node 自带的 npm 候选路径。
  const execpathCandidate = env['npm_execpath'];
  const execpathIsNpm =
    typeof execpathCandidate === 'string' &&
    basename(execpathCandidate).toLowerCase().startsWith('npm');
  const npmCandidates = [
    execpathIsNpm ? execpathCandidate : undefined,
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const npmCli = npmCandidates.find(existsSync);
  if (!npmCli) {
    throw new Error('cannot locate npm-cli.js; please reinstall Node.js with npm');
  }
  const npxCli = join(dirname(npmCli), 'npx-cli.js');
  if (!existsSync(npxCli)) {
    throw new Error(`cannot locate npx-cli.js next to ${npmCli}`);
  }
  return { npmCli, npxCli };
}

function runNodeCli(
  cliPath: string,
  args: string[],
  capture: boolean,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  const result = execFileSync(execPath, [cliPath, ...args], {
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 180_000,
    windowsHide: true,
  });
  return typeof result === 'string' ? result : '';
}
