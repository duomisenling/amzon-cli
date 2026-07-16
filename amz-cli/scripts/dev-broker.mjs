// 本地联调用:安全启动 Token Broker
//
// 用 Node 解析 amz-cli/.env(不经过 shell,凭证值不会被解释/回显),
// 把开发者的 SP 凭证映射成 broker 的"TEST 店铺",在 18080 端口起 broker。
// 仅用于本机验证 broker↔CLI 链路,不用于生产。
//
// 用法:node scripts/dev-broker.mjs   (在 amz-cli 目录下)

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const brokerServer = join(cliRoot, '..', 'amz-broker', 'server.mjs');

// 解析 .env(与 cli.ts 相同的宽松规则;值原样取,不做 shell 解释)
const env = {};
for (const line of readFileSync(join(cliRoot, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

for (const need of ['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'LWA_REFRESH_TOKEN']) {
  if (!env[need]) {
    console.error(`[dev-broker] .env 缺少 ${need}`);
    process.exit(1);
  }
}

const child = spawn(process.execPath, [brokerServer], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: '18080',
    TEAM_TOKENS: 'testuser:localtest123',
    LWA_CLIENT_ID: env.LWA_CLIENT_ID,
    LWA_CLIENT_SECRET: env.LWA_CLIENT_SECRET,
    RT_SP_TEST_NA: env.LWA_REFRESH_TOKEN,
    // 广告凭证若已配置,一并注入(没配就跳过,ads mint 会返回 store_not_configured)
    ...(env.ADS_CLIENT_ID ? { ADS_CLIENT_ID: env.ADS_CLIENT_ID } : {}),
    ...(env.ADS_CLIENT_SECRET ? { ADS_CLIENT_SECRET: env.ADS_CLIENT_SECRET } : {}),
    ...(env.ADS_REFRESH_TOKEN ? { RT_ADS_TEST: env.ADS_REFRESH_TOKEN } : {}),
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
