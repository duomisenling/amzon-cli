import type { Command } from 'commander';
import { outSuccess, progress } from '../internal/errs/output.js';
import type { PackageInfo } from '../internal/package-info.js';
import { initUserConfig, userConfigPath } from './config.js';
import { installAmzCli } from './install.js';
import {
  createCherryMcpConfig,
  parseMcpAccounts,
  writeCherryMcpConfig,
} from './mcp-config.js';

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
  config
    .command('mcp')
    .description('生成 Cherry Studio 可导入的单店或合并多店 MCP 配置(不读取凭证)')
    .option('--accounts <名称列表>', '命名账号,逗号分隔,对应 ~/.amz-cli/accounts/<名称>.env')
    .option('--combined', '生成一个多店铺 MCP；每次写操作必须通过 account 明确选择店铺')
    .option('--portable', '生成可交给其他 Windows 同事直接导入的配置，不写入本机绝对路径')
    .option('--include-default', '同时生成读取主 ~/.amz-cli/.env 的默认账号服务')
    .option(
      '--allow-writes',
      '生成的配置开启 MCP 正式写入(AMZ_MCP_ALLOW_WRITES=true)。仅限管理员确认 Cherry 使用逐次审批后使用；默认关闭',
    )
    .option('--output <文件>', '写成可直接导入的 JSON 文件；已有文件绝不覆盖')
    .action((options: { accounts?: string; combined?: boolean; portable?: boolean; includeDefault?: boolean; allowWrites?: boolean; output?: string }) => {
      const accounts = parseMcpAccounts(options.accounts);
      const mcpConfig = createCherryMcpConfig(accounts, {
        combined: Boolean(options.combined),
        portable: Boolean(options.portable),
        includeDefault: Boolean(options.includeDefault),
        allowWrites: Boolean(options.allowWrites),
      });
      const outputPath = options.output
        ? writeCherryMcpConfig(options.output, mcpConfig)
        : undefined;
      outSuccess({
        ...(outputPath ? { outputPath } : {}),
        config: mcpConfig,
        writesEnabled: Boolean(options.allowWrites),
        ...(options.allowWrites
          ? {}
          : {
              writesNote:
                'MCP 正式写入默认关闭(只能预览)。管理员确认 Cherry 使用逐次审批后,' +
                '可重新生成配置并加 --allow-writes,或手动把 AMZ_MCP_ALLOW_WRITES 改为 true。',
            }),
        accounts: [
          ...(options.includeDefault ? ['default'] : []),
          ...accounts,
        ],
        note: outputPath
          ? options.portable
            ? '把该 JSON 发给已安装同版本 amz-cli 的 Windows 同事，直接导入 Cherry Studio；安装后需重启 Cherry。'
            : options.combined
            ? '把该 JSON 导入 Cherry Studio；一个 MCP 会按必填 account 路由到隔离的固定店铺子进程。'
            : '把该 JSON 文件导入 Cherry Studio；每个 MCP 服务固定绑定一个店铺。'
          : '复制 data.config 的内容导入 Cherry Studio；也可加 --output <文件> 直接生成文件。',
      });
    });
}
