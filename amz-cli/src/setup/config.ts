import { chmodSync, constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ConfigInitResult {
  path: string;
  created: boolean;
}

export function userConfigPath(home: string = homedir()): string {
  return join(home, '.amz-cli', '.env');
}

/** 创建不含真实凭证的本地模式模板；已存在时绝不覆盖。 */
export function initUserConfig(
  home: string = homedir(),
  templatePath: string = fileURLToPath(new URL('../../.env.local.example', import.meta.url)),
): ConfigInitResult {
  const target = userConfigPath(home);
  if (existsSync(target)) return { path: target, created: false };

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // COPYFILE_EXCL 消除“检查后、复制前”被其他进程创建或替换配置的竞态。
  try {
    copyFileSync(templatePath, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { path: target, created: false };
    }
    throw error;
  }
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows 上 chmod 只映射只读位；无法设置时保留默认 ACL，由安装指南提示保护文件。
  }
  return { path: target, created: true };
}
