// doctor egress —— 检查这个账号的请求实际从哪个 IP 发出
//
// 为什么需要它:出口 IP 变化是**不会报错**的 —— 命令照跑、数据照拿,
// 只是换了个地址出去。代理服务器被重建、云厂商换网络、配置写错账号,
// 都会造成这种静默变化。这条命令把实际出口显式打出来,便于定期核对。

import type { ToolDefinition } from '../../tools/types.js';
import { amazonFetch, egressStatus, type EgressChannel } from '../../internal/net/egress.js';

/** 只回显调用方 IP、不含任何业务数据的公共服务。 */
const DEFAULT_IP_ECHO_URL = 'https://api.ipify.org';

/** 用于验证代理目的地限制的地址;它不在允许清单里,预期应当被拒绝。 */
const RESTRICTED_PROBE_URL = 'https://example.com';

/**
 * 回显服务地址。可用 AMZ_EGRESS_PROBE_URL 换成自建的 ——
 * 有些网络环境访问不了默认地址,直连的账号可能需要换一个能通的。
 */
function ipEchoUrl(): string {
  const custom = process.env['AMZ_EGRESS_PROBE_URL']?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_IP_ECHO_URL;
}

/** 走该通道实际发一次请求,拿到对端会看到的那个 IP。 */
async function probeEgressIp(channel: EgressChannel): Promise<{ ip?: string; error?: string }> {
  try {
    const resp = await amazonFetch(ipEchoUrl(), { signal: AbortSignal.timeout(20_000) }, channel);
    if (!resp.ok) return { error: `IP 回显服务返回 HTTP ${resp.status}` };
    const ip = (await resp.text()).trim();
    return ip ? { ip } : { error: 'IP 回显服务返回了空内容' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 验证代理的目的地限制生效(最小权限)。
 *
 * 代理应当只放行本工具需要的 API 域名。这里访问一个不在清单里的地址,
 * **预期是被拒绝**;如果反而通了,说明这台代理没有做目的地限制,
 * 一旦凭据外泄就可能被拿去中转任意流量。
 */
async function probeDestinationRestricted(): Promise<{ restricted: boolean; detail: string }> {
  try {
    const resp = await amazonFetch(
      RESTRICTED_PROBE_URL,
      { signal: AbortSignal.timeout(15_000) },
      'sp',
    );
    return {
      restricted: false,
      detail:
        `⚠️ 清单外的地址竟然能通(HTTP ${resp.status})。这台代理没有做目的地限制,` +
        '建议在服务端只放行需要的 API 域名。',
    };
  } catch {
    return { restricted: true, detail: '清单外的地址已被拒绝(符合预期)' };
  }
}

export const doctorEgress: ToolDefinition = {
  service: 'doctor',
  command: 'egress',
  description:
    '检查当前账号的请求实际从哪个 IP 发出。' +
    '配置了 SP_API_PROXY 就走代理,没配则直连;' +
    '结果应与该账号的预期出口一致,不一致说明代理失效或用错了账号',
  mutation: 'none',
  flags: [
    {
      name: 'skip-restriction-check',
      type: 'boolean',
      desc: '跳过"代理目的地限制"这项检查(默认会做,多花几秒)',
    },
  ],
  execute: async (ctx) => {
    const status = egressStatus();

    ctx.progress(
      status.sp.configured
        ? `· 正在经代理 ${status.sp.proxy} 探测实际出口 IP...`
        : '· 当前账号未配置代理(直连),正在探测本机实际出口 IP...',
    );
    const sp = await probeEgressIp('sp');

    // 广告用的是另一个代理时才单独探一次,否则结果必然相同,没必要多发一次请求
    const adsSeparate = status.ads.configured && !status.ads.inheritsFromSp;
    const ads = adsSeparate ? await probeEgressIp('ads') : undefined;
    if (adsSeparate) ctx.progress(`· 广告接口配了独立代理 ${status.ads.proxy},单独探测...`);

    // 只有代理确实连得通才做这项检查:代理整个不通时,清单外地址当然也连不上,
    // 那个"被拒绝"是所有请求都失败带来的假象,报"符合预期"会误导人。
    let restriction: { restricted: boolean; detail: string } | undefined;
    if (status.sp.configured && sp.ip && ctx.flags['skipRestrictionCheck'] !== true) {
      ctx.progress('· 正在验证代理的目的地限制...');
      restriction = await probeDestinationRestricted();
    }

    const hints: string[] = [];
    if (!status.sp.configured) {
      hints.push(
        '这个账号没有配置 SP_API_PROXY,请求直连。' +
          '如果这是有意为之那没问题;否则请管理员在该账号的 .env 里补上。',
      );
    }
    if (sp.error) {
      hints.push(
        status.sp.configured
          ? '经代理探测失败。代理不通时 CLI 会直接报错、不回退直连,所以该账号现在跑任何命令都会失败。' +
            '请管理员检查代理服务是否存活、防火墙端口是否放行。' +
            '另外:本机若跑着全局 VPN,会截走流量导致连不上代理,需要把代理服务器地址加进 VPN 的直连规则。'
          : '直连探测失败,可能是本机网络问题,或该 IP 回显服务不可达(可用 AMZ_EGRESS_PROBE_URL 换一个)。',
      );
    }
    if (restriction && !restriction.restricted) hints.push(restriction.detail);
    if (!status.label && status.sp.configured) {
      hints.push('建议同时配置 EGRESS_LABEL,审计日志才能标出这条请求走的是哪个出口。');
    }

    return {
      ...(status.label ? { egressLabel: status.label } : {}),
      spApi: {
        proxyConfigured: status.sp.configured,
        ...(status.sp.proxy ? { proxy: status.sp.proxy } : {}),
        ...(sp.ip ? { egressIp: sp.ip } : {}),
        ...(sp.error ? { error: sp.error } : {}),
      },
      ads: {
        proxyConfigured: status.ads.configured,
        inheritsFromSpApi: status.ads.inheritsFromSp,
        ...(adsSeparate && status.ads.proxy ? { proxy: status.ads.proxy } : {}),
        ...(ads?.ip ? { egressIp: ads.ip } : {}),
        ...(ads?.error ? { error: ads.error } : {}),
      },
      ...(restriction
        ? { destinationRestricted: restriction.restricted, restrictionDetail: restriction.detail }
        : {}),
      ...(hints.length > 0 ? { hints } : {}),
      note:
        'egressIp 就是对端会看到的 IP。请与该账号的预期出口核对;' +
        '对不上说明代理失效、服务器被重建换了地址,或者命令用错了 --account。',
    };
  },
};
