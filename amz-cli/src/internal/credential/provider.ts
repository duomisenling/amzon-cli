// 凭证抽象(设计决策 2:可切换的 CredentialProvider)
//
// 两个实现:
//   local.ts  —— 开发阶段:本地 .env 里的 refresh_token 直接换 access_token
//   broker.ts —— 部署阶段:向 Zeabur Token Broker 领取短期令牌(第二步实现)
//
// 业务代码只依赖本接口,切换凭证来源不改任何业务代码。

import type { Region } from '../client/regions.js';

export interface AccessCredentials {
  /** LWA access_token,有效期约 1 小时,只存进程内存,绝不落盘 */
  accessToken: string;
  /** 该凭证对应的 SP-API 端点 */
  endpoint: string;
  region: Region;
}

export interface CredentialProvider {
  /**
   * 返回可用的 access_token(内部负责缓存与过期刷新)。
   * region 省略时用默认区域(SP_API_REGION);指定时按区域选凭证与端点
   * ——同一账号跨区域时,每个区域有各自的 refresh token(亚马逊按区域签发)。
   */
  getCredentials(region?: Region): Promise<AccessCredentials>;
}
