import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AmzError } from './errs/errors.js';

type Env = NodeJS.ProcessEnv;

// 这些值决定实际访问的店铺。显式选择本地账号时必须先清空，防止账号文件
// 缺少某一区域配置后，静默继承 shell 或默认 .env 中另一个店铺的值。
const ACCOUNT_CREDENTIAL_KEYS = [
  'LWA_CLIENT_ID',
  'LWA_CLIENT_SECRET',
  'LWA_REFRESH_TOKEN',
  'LWA_REFRESH_TOKEN_NA',
  'LWA_REFRESH_TOKEN_EU',
  'LWA_REFRESH_TOKEN_FE',
  'SELLER_ID',
  'SELLER_ID_NA',
  'SELLER_ID_EU',
  'SELLER_ID_FE',
  'ADS_CLIENT_ID',
  'ADS_CLIENT_SECRET',
  'ADS_REFRESH_TOKEN',
  // 区域/沙盒/User-Agent 同样按账号生效,账号文件省略某行时必须落到默认值,
  // 而不是静默继承共享 .env 或上一个账号的值。SP_API_SANDBOX 残留尤其危险:
  // 会把该账号的请求整个打到沙盒(mock 数据当真数据),或反过来。
  'SP_API_REGION',
  'SP_API_SANDBOX',
  'SP_API_USER_AGENT',
  'ADS_USER_AGENT',
  'ADS_REGION',
  // 代理配置按账号生效,必须和凭证一起清空:否则上一个账号的代理会串到下一个。
  // 这也保证了"某个账号就是要直连"只需不填,不会被别处的配置污染
  // (哪怕共享 .env 或系统环境变量里设了,切账号时也会被清掉)。
  'SP_API_PROXY',
  'ADS_PROXY',
  'EGRESS_LABEL',
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

/**
 * 加载默认凭证；已有 shell 环境值优先。
 *
 * 兼容旧版：cwd/.env 中出现任一 amz-cli 配置键时，整份文件作为当前项目配置。
 * 全局安装：cwd 没有 amz-cli 配置时，回退到 ~/.amz-cli/.env。
 * 两份文件绝不混合，避免本地店铺凭证与用户目录中的 Broker/其他店铺身份串用。
 */
export function loadDotEnvIfPresent(
  env: Env = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): void {
  if ((env['AMZ_CLI_SKIP_DOTENV'] ?? '').trim().toLowerCase() === 'true') return;

  const projectVars = readEnvFile(join(cwd, '.env'));
  const userVars = readEnvFile(join(home, '.amz-cli', '.env'));
  const selected = Object.keys(projectVars).some(isAmzCliConfigKey) ? projectVars : userVars;
  for (const [key, value] of Object.entries(selected)) {
    if (!(key in env)) env[key] = value;
  }
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvText(readFileSync(path, 'utf8'));
  } catch {
    // 没有配置文件是正常情况(Broker 系统环境变量/CI)。
    return {};
  }
}

function isAmzCliConfigKey(key: string): boolean {
  return /^(?:LWA_|ADS_|SELLER_ID(?:_|$)|BROKER_URL$|TEAM_TOKEN$|STORE$|SP_API_|EGRESS_)/.test(key);
}

/**
 * 在 accounts 目录里大小写不敏感地找账号文件,返回规范名(文件实际大小写)和路径。
 * 先精确命中(最快、也照顾大小写敏感的文件系统),再回退到大小写不敏感扫描。
 */
function resolveAccountFile(dir: string, account: string): { file: string; canonical: string } | undefined {
  // 直接读目录拿真实文件名大小写:Windows 文件系统不分大小写,existsSync 对
  // 任意大小写都返回 true,拿不到规范名。先精确命中,再回退大小写不敏感。
  const wanted = `${account}.env`;
  const target = wanted.toLowerCase();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined; // accounts 目录不存在等,按未命中处理
  }
  const exact = names.find((n) => n === wanted);
  if (exact) return { file: join(dir, exact), canonical: account };
  const ci = names.find((n) => n.toLowerCase() === target);
  if (ci) return { file: join(dir, ci), canonical: ci.slice(0, -'.env'.length) };
  return undefined;
}

/**
 * 加载显式选择的账号。调用前应先加载默认 .env，以便识别 Broker 模式；
 * 本地账号文件随后完整覆盖并隔离店铺凭证。
 *
 * 账号名大小写不敏感:用户可传 `shopa`,自动匹配到 `ShopA.env`。
 * 返回归一后的规范账号名(本地=文件实际大小写;Broker=原样),
 * 供调用方统一用于审计归属与店铺路由,避免同店分成两个名字。
 */
export function loadAccount(
  account: string,
  opts: { env?: Env; home?: string; stderr?: (text: string) => void } = {},
): string {
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

  const dir = join(home, '.amz-cli', 'accounts');
  const resolved = resolveAccountFile(dir, account);
  if (resolved) {
    clearKeys(env, [...ACCOUNT_CREDENTIAL_KEYS, ...BROKER_KEYS]);
    const vars = parseEnvText(readFileSync(resolved.file, 'utf8'));
    for (const [key, value] of Object.entries(vars)) env[key] = value;
    if (env['BROKER_URL']?.trim() && !env['STORE']?.trim()) {
      env['STORE'] = brokerStoreName(resolved.canonical);
    }
    writeStderr(`👤 [账号] ${resolved.canonical}(凭证来自 ${resolved.file})\n`);
    return resolved.canonical;
  }

  // Broker 的共享 URL/团队令牌来自默认 .env；切店时清除所有本地店铺身份，
  // Seller ID 将随 Broker 的短期凭证一并返回。
  if (env['BROKER_URL']?.trim()) {
    clearKeys(env, ACCOUNT_CREDENTIAL_KEYS);
    env['STORE'] = brokerStoreName(account);
    writeStderr(`👤 [账号] ${account}(Broker 店铺 ${env['STORE']})\n`);
    return account;
  }

  throw new AmzError({
    type: 'invalid_param',
    subtype: 'account_not_found',
    param: '--account',
    hintAgent: 'report_to_human',
    hintHuman:
      `账号 "${account}" 不存在:没有找到凭证文件 ${join(dir, `${account}.env`)}(大小写不敏感),也没有配置 Broker。` +
      `请创建该文件(内容参考 .env.example)或联系管理员在 Broker 端开通。`,
    message: `account file not found for: ${account} (and BROKER_URL not set)`,
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
