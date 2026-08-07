// 代理支持 —— 让发往亚马逊接口的请求通过指定的代理服务器发出。
//
// 用途:部分部署环境要求 API 请求经由固定的服务器出去(企业网络策略、
// 对端要求固定来源地址、按账号分配不同网络出口等)。按账号配置,互不影响。
//
// 配置项(写在各账号自己的 accounts/<账号>.env):
//   SP_API_PROXY  代理地址,如 http://user:pass@1.2.3.4:38128
//   ADS_PROXY     广告接口专用;留空则复用 SP_API_PROXY
//   EGRESS_LABEL  出口标签,只写进审计日志便于核对(不含密码)
//
// 三条约定:
//   1. 未配置 = 直连。行为与引入本模块之前完全一致,是向后兼容的改动。
//      因此"某个账号就是要直连"不需要任何开关,不填即可。
//   2. 配置了代理但连不上 = 直接失败,不回退直连。
//      回退看似稳健,实际是静默绕过既定的网络配置,而且不会有人察觉——
//      一次故障就让配置形同虚设。宁可让这个账号的命令失败。
//   3. 只有发往亚马逊的请求走代理。审计上报、Broker 领凭证打的是自建服务,
//      不经过代理。
//
// 实现说明:用 undici 的 fetch 而不是 Node 内置的全局 fetch。Node 内部虽然也是
// undici,但没有把 ProxyAgent 暴露出来;而把 npm 版的 ProxyAgent 传给内置 fetch
// 会因为两份 undici 的内部符号不一致而失败。所以 fetch 和 ProxyAgent 必须来自
// 同一个包。

import { fetch as undiciFetch, ProxyAgent } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { AmzError } from '../errs/errors.js';

/** 请求属于哪套接口体系 —— 决定读 SP_API_PROXY 还是 ADS_PROXY。 */
export type EgressChannel = 'sp' | 'ads';

/**
 * 响应的结构化最小集。
 *
 * 走代理时用 undici 的 Response,不走代理时用全局 Response —— 两者结构一致,
 * 但 TypeScript 里是两个不同的类型。这里声明调用方实际用到的那几个成员,
 * 两边都满足它,调用方就不必关心本次请求是怎么发出去的。
 */
export interface EgressResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 请求参数的最小集(同样要同时喂给两种 fetch)。 */
export interface EgressRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

/** 当前账号的出口标签,只用于审计日志核对;未配置返回 undefined。 */
export function egressLabel(): string | undefined {
  const v = process.env['EGRESS_LABEL']?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** 取该通道生效的代理配置;都没配返回 undefined(= 直连)。 */
function resolveProxy(channel: EgressChannel): { url: string; envName: string } | undefined {
  if (channel === 'ads') {
    const ads = process.env['ADS_PROXY']?.trim();
    if (ads) return { url: ads, envName: 'ADS_PROXY' };
  }
  const sp = process.env['SP_API_PROXY']?.trim();
  if (sp) return { url: sp, envName: 'SP_API_PROXY' };
  return undefined;
}

/**
 * 代理地址里可以安全示人的部分(协议 + 主机 + 端口),用于报错和日志。
 * 绝不返回用户名密码 —— 报错信息会进日志、可能被转发给别人。
 */
export function redactProxy(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(代理地址无法解析)';
  }
}

/** ProxyAgent 持有连接池,必须复用;每次请求新建会泄漏 socket。 */
const agents = new Map<string, ProxyAgent>();

/**
 * 取(或创建)该代理地址的 dispatcher。
 * 地址格式错误在这里抛 —— 此时一个字节都还没发出去,对写请求是安全的。
 */
function agentFor(url: string, envName: string): ProxyAgent {
  const cached = agents.get(url);
  if (cached) return cached;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'egress.invalid_proxy_url',
      param: envName,
      hintAgent: 'report_to_human',
      hintHuman:
        `${envName} 的格式不对,无法解析成一个地址。正确格式:` +
        'http://用户名:密码@服务器地址:端口。请联系管理员核对。',
      message: `${envName} is not a valid URL`,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AmzError({
      type: 'invalid_param',
      subtype: 'egress.unsupported_proxy_scheme',
      param: envName,
      hintAgent: 'report_to_human',
      hintHuman:
        `${envName} 只支持 http:// 或 https:// 开头的代理地址,当前是 "${parsed.protocol}"。` +
        '(socks5 等其他类型暂不支持。)请联系管理员核对。',
      message: `${envName} has unsupported protocol: ${parsed.protocol}`,
    });
  }

  const agent = new ProxyAgent(url);
  agents.set(url, agent);
  return agent;
}

/**
 * 发一个请求。所有发往亚马逊的 HTTP 调用都应该经过它。
 *
 * 未配置代理时行为等同于普通 fetch。配置了代理时只走代理,失败就抛错,
 * 不会改走直连。
 *
 * 这里刻意不把网络错误包装成 AmzError:调用方(client.ts / ads-client.ts)
 * 对写请求有一套"结果未知、不得重试"的判定,那套判定必须继续生效。
 * 这里只在报错信息前面缀上代理标识,便于区分是代理不可用还是网络本身有问题。
 */
export async function amazonFetch(
  input: string | URL,
  init: EgressRequestInit,
  channel: EgressChannel,
): Promise<EgressResponse> {
  const proxy = resolveProxy(channel);
  // 未配置代理就用 Node 内置的全局 fetch —— 与引入本模块之前是同一个实现,
  // "不配代理 = 行为完全不变"因此是字面意义上的成立(而不是"换了个等价实现")。
  // undici 只在真的需要代理时才介入。
  if (!proxy) return globalThis.fetch(input, init as RequestInit);

  const dispatcher = agentFor(proxy.url, proxy.envName);
  try {
    return await undiciFetch(input, { ...init, dispatcher } as UndiciRequestInit);
  } catch (err) {
    const label = egressLabel();
    const who = label ? `[${label}] ` : '';
    throw new Error(
      `经代理 ${who}${redactProxy(proxy.url)} 请求失败(未回退直连): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** 当前账号的代理配置概览(不含密码),给 doctor 命令和排查用。 */
export function egressStatus(): {
  label?: string;
  sp: { configured: boolean; proxy?: string };
  ads: { configured: boolean; proxy?: string; inheritsFromSp: boolean };
} {
  const sp = resolveProxy('sp');
  const ads = resolveProxy('ads');
  return {
    ...(egressLabel() ? { label: egressLabel() } : {}),
    sp: sp ? { configured: true, proxy: redactProxy(sp.url) } : { configured: false },
    ads: ads
      ? { configured: true, proxy: redactProxy(ads.url), inheritsFromSp: ads.envName === 'SP_API_PROXY' }
      : { configured: false, inheritsFromSp: false },
  };
}

/**
 * 关闭所有代理连接池。
 *
 * **CLI 退出前必须调用**:ProxyAgent 持有的连接池会一直占着事件循环,
 * 不关的话命令跑完了进程也不会退出 —— 表现为"命令卡住没反应",
 * 而且卡在业务逻辑之后,日志上什么都看不出来。
 * (未配代理的账号没有 agent,这个调用是空操作。)
 */
export async function closeEgressAgents(): Promise<void> {
  const all = [...agents.values()];
  agents.clear();
  // 必须用 destroy() 而不是 close():close() 是优雅关闭,会等待在途连接结束。
  // 代理不可达时那些连接永远不会结束,close() 就永远不返回 —— 表现为命令跑完卡死,
  // 而且恰恰发生在"代理出问题"这个最需要看到报错的时候。
  await Promise.all(all.map((a) => a.destroy().catch(() => undefined)));
}
