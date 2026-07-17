import type { Command } from 'commander';
import { outSuccess, progress } from '../internal/errs/output.js';
import type { PackageInfo } from '../internal/package-info.js';
import { initUserConfig, userConfigPath } from './config.js';
import { installAmzCli } from './install.js';

export function registerSetupCommands(program: Command, info: PackageInfo): void {
  program
    .command('install')
    .description('安装或升级全局 CLI、同版本 Agent Skill，并准备用户配置目录')
    .option('--dry-run', '只显示安装计划，不修改系统、不访问网络')
    .action((options: { dryRun?: boolean }) => {
      if (!options.dryRun) progress(`正在安装 ${info.name}@${info.version} 及同版本 Agent Skill...`);
      const result = installAmzCli(info, { dryRun: Boolean(options.dryRun) });
      if (!options.dryRun) {
        progress(
          result.config?.created
            ? `已创建配置模板：${result.config.path}`
            : `保留已有配置：${result.config?.path}`,
        );
      }
      outSuccess(result);
    });

  const config = program.command('config').description('管理本机 amz-cli 配置文件');
  config
    .command('path')
    .description('显示全局安装使用的用户配置路径')
    .action(() => outSuccess({ path: userConfigPath() }));
  config
    .command('init')
    .description('创建不含真实凭证的本地模式配置模板；已有文件绝不覆盖')
    .action(() => outSuccess(initUserConfig()));
}
