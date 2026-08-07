// accounts —— 列出本机配置了凭证文件的店铺账号(只看文件名,绝不读取文件内容)
//
// 动机:此前没有这个命令时,AI 会自己去拼系统 ls 命令列 accounts 目录,
// Windows 反斜杠路径在 bash 环境里被转义吃掉,稳定报错。给个正经命令一劳永逸。

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '../../tools/types.js';

/** 纯逻辑:从目录文件名列表提取账号名(去掉 .env 后缀,忽略其他文件),按字母序。 */
export function accountNamesFromFiles(fileNames: string[]): string[] {
  return fileNames
    .filter((name) => name.toLowerCase().endsWith('.env'))
    .map((name) => name.slice(0, -'.env'.length))
    .sort((a, b) => a.localeCompare(b));
}

export const accountsList: ToolDefinition = {
  service: 'accounts',
  command: 'list',
  description:
    '列出本机已配置凭证文件的店铺账号(~/.amz-cli/accounts/ 下的文件名,不读取内容)。用 --account <名称> 切换店铺',
  mutation: 'none',
  flags: [],
  execute: async (ctx) => {
    const dir = join(homedir(), '.amz-cli', 'accounts');
    let names: string[];
    try {
      names = accountNamesFromFiles(readdirSync(dir));
    } catch {
      // 目录不存在 = 还没配置过多账号,不算错误
      names = [];
    }
    ctx.progress(`· 共找到 ${names.length} 个账号凭证文件`);
    return {
      count: names.length,
      accounts: names,
      dir,
      note:
        names.length > 0
          ? '账号名大小写不敏感;任意命令加 --account <名称> 即以该店铺身份执行。'
          : `该目录下还没有账号凭证文件。请管理员按模板创建 ${join(dir, '<店铺代号>.env')}。`,
    };
  },
};
