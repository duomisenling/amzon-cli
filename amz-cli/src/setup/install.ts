import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export function createInstallPlan(info: PackageInfo, home?: string): InstallPlan {
  const spec = `${info.name}@${info.version}`;
  return {
    package: spec,
    commands: [
      ['npm', 'install', '--global', spec],
      [
        'npx',
        '--yes',
        'skills',
        'add',
        `<npm-global-root>/${info.name}/skills/amz-cli`,
        '--yes',
        '--global',
      ],
    ],
    configPath: userConfigPath(home),
    effects: [
      '安装或升级全局 amz-cli 与 amz-cli-mcp 命令',
      '安装与当前 npm 包同版本的 amz-cli Agent Skill',
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
    const globalRoot = runNpm(['root', '--global'], true).trim();
    const globalPackageRoot = join(globalRoot, ...info.name.split('/'));
    const skillPath = join(globalPackageRoot, 'skills', 'amz-cli');
    if (!existsSync(join(skillPath, 'SKILL.md'))) {
      throw new Error(`installed package is missing Skill: ${skillPath}`);
    }
    runNpx(['--yes', 'skills', 'add', skillPath, '--yes', '--global']);

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
  const npmCandidates = [
    env['npm_execpath'],
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
