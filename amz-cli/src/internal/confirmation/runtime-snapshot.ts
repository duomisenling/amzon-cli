import { createHash } from 'node:crypto';

/**
 * 绑定会影响目标账户、店铺和区域的运行环境。
 * 敏感值只参与 SHA-256，不会写入预览令牌记录。
 */
export function runtimeConfirmationSnapshot(): Record<string, unknown> {
  const plainKeys = [
    'BROKER_URL',
    'STORE',
    'SP_API_REGION',
    'ADS_REGION',
    'LWA_CLIENT_ID',
    'ADS_CLIENT_ID',
    'SELLER_ID',
    'SELLER_ID_NA',
    'SELLER_ID_EU',
    'SELLER_ID_FE',
  ];
  const secretKeys = [
    'TEAM_TOKEN',
    'LWA_REFRESH_TOKEN',
    'LWA_REFRESH_TOKEN_NA',
    'LWA_REFRESH_TOKEN_EU',
    'LWA_REFRESH_TOKEN_FE',
    'ADS_REFRESH_TOKEN',
  ];
  const plain = Object.fromEntries(plainKeys.map((key) => [key, process.env[key] ?? '']));
  const credentialHash = createHash('sha256')
    .update(JSON.stringify(secretKeys.map((key) => process.env[key] ?? '')))
    .digest('hex');
  return { ...plain, credentialHash };
}
