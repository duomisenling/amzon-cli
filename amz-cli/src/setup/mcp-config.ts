import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmzError } from '../internal/errs/errors.js';

export const DEFAULT_MCP_ALLOWED_WRITES = [
  'listing.update',
  'ads.campaign-create',
  'ads.campaign-extend',
  'ads.campaign-state',
  'ads.campaign-budget',
  'ads.keyword-bid',
  'ads.negative-keyword',
  'ads.keyword-campaign-launch',
] as const;

interface CherryMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CherryMcpConfig {
  mcpServers: Record<string, CherryMcpServerConfig>;
}

interface McpConfigOptions {
  includeDefault?: boolean;
  combined?: boolean;
  portable?: boolean;
  execPath?: string;
  serverPath?: string;
  allowedWrites?: readonly string[];
  allowWrites?: boolean;
  platform?: NodeJS.Platform;
}

const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function parseMcpAccounts(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const accounts = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const account of accounts) {
    if (!ACCOUNT_PATTERN.test(account)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'invalid_account_name',
        param: '--accounts',
        hintAgent: 'fix_param',
        hintHuman: `账号名 "${account}" 无效:只能包含字母、数字、连字符和下划线,最长 64 个字符。`,
        message: `invalid account name in --accounts: ${account}`,
      });
    }
    const normalized = account.toLowerCase();
    if (seen.has(normalized)) {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'duplicate_account_name',
        param: '--accounts',
        hintAgent: 'fix_param',
        hintHuman: `账号 "${account}" 重复,请在 --accounts 中只保留一次。`,
        message: `duplicate account name in --accounts: ${account}`,
      });
    }
    seen.add(normalized);
  }
  return accounts;
}

export function packagedMcpServerPath(moduleUrl: string | URL = import.meta.url): string {
  return fileURLToPath(new URL('../mcp-server.js', moduleUrl));
}

export function createCherryMcpConfig(
  accounts: readonly string[],
  options: McpConfigOptions = {},
): CherryMcpConfig {
  if (accounts.length === 0 && !options.includeDefault) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'mcp_accounts_required',
      param: '--accounts',
      hintAgent: 'fix_param',
      hintHuman: '至少提供一个命名账号(--accounts shop-a,shop-b),或使用 --include-default 包含主 .env 默认账号。',
      message: 'MCP config requires at least one named account or --include-default',
    });
  }
  if (options.combined && options.includeDefault) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'combined_mcp_default_unsupported',
      param: '--combined/--include-default',
      hintAgent: 'fix_param',
      hintHuman: '合并多店铺 MCP 要求每次明确选择命名店铺，不能同时包含无名称的默认账号。',
      message: 'combined MCP cannot include the unnamed default account',
    });
  }

  const platform = options.platform ?? process.platform;
  if (options.portable && platform !== 'win32') {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'portable_mcp_windows_only',
      param: '--portable',
      hintAgent: 'fix_param',
      hintHuman: '--portable 当前生成 Windows Cherry Studio 配置，只能在 Windows 上使用。',
      message: 'portable MCP config is currently supported on Windows only',
    });
  }

  const execPath = options.execPath ?? process.execPath;
  const serverPath = options.serverPath ?? packagedMcpServerPath();
  if (!options.portable && !existsSync(serverPath)) {
    throw new AmzError({
      type: 'internal',
      subtype: 'setup.mcp_server_missing',
      hintAgent: 'report_to_human',
      hintHuman: '找不到已编译的 amz-cli-mcp 服务文件。请使用正式安装的 amz-cli 运行此命令,或先执行 npm run build。',
      message: `compiled MCP server is missing: ${serverPath}`,
    });
  }

  const allowedWrites = options.allowedWrites ?? DEFAULT_MCP_ALLOWED_WRITES;
  // 写入总开关默认关闭(显式写 false,而不是省略):这是 mcp/common.ts 承诺的
  // "MCP 正式写入默认关闭,管理员确认后才能开启"。只有管理员传 --allow-writes
  // 生成的配置才带 true;操作白名单照常写入,方便日后只翻转一个开关。
  const env = {
    AMZ_MCP_ALLOW_WRITES: options.allowWrites ? 'true' : 'false',
    AMZ_MCP_ALLOWED_WRITES: allowedWrites.join(','),
  };
  const mcpServers: Record<string, CherryMcpServerConfig> = {};
  const serverConfig = (serverArgs: string[]): CherryMcpServerConfig => {
    if (options.portable) {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', ['amz-cli-mcp', ...serverArgs].join(' ')],
        env: { ...env },
      };
    }
    return {
      command: execPath,
      args: [serverPath, ...serverArgs],
      env: { ...env },
    };
  };

  if (options.combined) {
    mcpServers['Amazon Safe Writes - 多店铺'] = serverConfig([
      '--accounts',
      accounts.join(','),
    ]);
    return { mcpServers };
  }

  if (options.includeDefault) {
    mcpServers['Amazon Safe Writes - 默认账号'] = serverConfig([]);
  }
  for (const account of accounts) {
    mcpServers[`Amazon Safe Writes - ${account}`] = serverConfig(['--account', account]);
  }

  return { mcpServers };
}

export function writeCherryMcpConfig(path: string, config: CherryMcpConfig): string {
  const target = resolve(path);
  try {
    writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AmzError({
        type: 'invalid_param',
        subtype: 'output_file_exists',
        param: '--output',
        hintAgent: 'report_to_human',
        hintHuman: `输出文件已存在,为避免覆盖已配置的 MCP 服务,CLI 已停止:${target}`,
        message: `MCP config output already exists: ${target}`,
      });
    }
    throw error;
  }
  return target;
}
