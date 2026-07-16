import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AmzError } from './errs/errors.js';

type Env = NodeJS.ProcessEnv;

// 这些值决定实际访问的店铺。显式选择本地账号时必须先清空，防止账号文件
// 缺少某一区域配置后，静默继承 shell 或默认 .env 中另一个店铺的值。
const ACCOUNT_CREDENTIAL_KEYS = [
  'LWA_REFRESH_TOKEN',
  'LWA_REFRESH_TOKEN_NA',
  'LWA_REFRESH_TOKEN_EU',
  'LWA_REFRESH_TOKEN_FE',
  'SELLER_ID',
  'SELLER_ID_NA',
  'SELLER_ID_EU',
  'SELLER_ID_FE',
  'ADS_REFRESH_TOKEN',
] as const;

const BROKER_KEYS = ['BROKER_URL', 'TEAM_TOKEN', 'STORE'] as const;

/** 解析 KEY=VALUE 格式的 env 文本,返回键值对(跳过注释与空行)。 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** 从 argv 提取全局 --account，并在 commander 解析前移除。 */
export function extractAccountArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--account');
  if (i >= 0) {
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) throw accountMissingValue();
    argv.splice(i, 2);
    return value;
  }
  const pref = argv.findIndex((a) => a.startsWith('--account='));
  if (pref >= 0) {
    const value = argv[pref]!.slice('--account='.length);
    if (!value) throw accountMissingValue();
    argv.splice(pref, 1);
    return value;
  }
  return undefined;
}

/** 加载 cwd 的默认 .env；已有 shell 环境值优先。 */
export function loadDotEnvIfPresent(env: Env = process.env, cwd = process.cwd()): void {
  if ((env['AMZ_CLI_SKIP_DOTENV'] ?? '').trim().toLowerCase() === 'true') return;
  try {
    const vars = parseEnvText(readFileSync(join(cwd, '.env'), 'utf8'));
    for (const [key, value] of Object.entries(vars)) {
      if (!(key in env)) env[key] = value;
    }
  } catch {
    // 没有 .env 是正常情况(Broker 系统环境变量/CI)。
  }
}

/**
 * 加载显式选择的账号。调用前应先加载默认 .env，以便识别 Broker 模式；
 * 本地账号文件随后完整覆盖并隔离店铺凭证。
 */
export function loadAccount(
  account: string,
  opts: { env?: Env; home?: string; stderr?: (text: string) => void } = {},
): void {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const writeStderr = opts.stderr ?? ((text: string) => process.stderr.write(text));

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(account)) {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'invalid_account_name',
      param: '--account',
      hintAgent: 'fix_param',
      hintHuman: `账号名 "${account}" 无效:只能包含字母、数字、连字符和下划线。`,
      message: `invalid account name: ${account}`,
    });
  }

  const file = join(home, '.amz-cli', 'accounts', `${account}.env`);
  if (existsSync(file)) {
    clearKeys(env, [...ACCOUNT_CREDENTIAL_KEYS, ...BROKER_KEYS]);
    const vars = parseEnvText(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(vars)) env[key] = value;
    if (env['BROKER_URL']?.trim() && !env['STORE']?.trim()) {
      env['STORE'] = brokerStoreName(account);
    }
    writeStderr(`👤 [账号] ${account}(凭证来自 ${file})\n`);
    return;
  }

  // Broker 的共享 URL/团队令牌来自默认 .env；切店时清除所有本地店铺身份，
  // Seller ID 将随 Broker 的短期凭证一并返回。
  if (env['BROKER_URL']?.trim()) {
    clearKeys(env, ACCOUNT_CREDENTIAL_KEYS);
    env['STORE'] = brokerStoreName(account);
    writeStderr(`👤 [账号] ${account}(Broker 店铺 ${env['STORE']})\n`);
    return;
  }

  throw new AmzError({
    type: 'invalid_param',
    subtype: 'account_not_found',
    param: '--account',
    hintAgent: 'report_to_human',
    hintHuman:
      `账号 "${account}" 不存在:没有找到凭证文件 ${file},也没有配置 Broker。` +
      `请创建该文件(内容参考 .env.example)或联系管理员在 Broker 端开通。`,
    message: `account file not found: ${file} (and BROKER_URL not set)`,
  });
}

function clearKeys(env: Env, keys: readonly string[]): void {
  for (const key of keys) delete env[key];
}

function brokerStoreName(account: string): string {
  return account.toUpperCase().replace(/-/g, '_');
}

function accountMissingValue(): AmzError {
  return new AmzError({
    type: 'invalid_param',
    subtype: 'account_missing_value',
    param: '--account',
    hintAgent: 'fix_param',
    hintHuman: '--account 后面需要账号名称,例如 --account shop-a。',
    message: '--account requires a value',
  });
}
