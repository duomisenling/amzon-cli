// 审计日志 —— 按店铺(账号)记录每次 API 请求;本地落盘 + 可选上报到中央服务器。
//
// 设计:
//   - 只记"访问了什么"(时间/账号/机器/操作/接口/方法/状态),不记 PII 具体值。
//   - 本地:按账号分目录、按月分文件 <dir>/<账号>/<YYYY-MM>.log(ndjson)。默认开启。
//     AMZ_AUDIT_DIR 改路径;AMZ_AUDIT_DISABLE=1 关闭本地落盘。
//   - 中央上报(可选):配了 AMZ_AUDIT_HTTP 就把本次运行的所有审计行,在进程退出前
//     一次性 POST 到服务器(Authorization: Bearer AMZ_AUDIT_TOKEN)。上报是"额外一路":
//     短超时、失败即忽略,本地文件仍是可靠底账;不拖慢、不阻断命令。
//   - node(机器/同事标识):AMZ_AUDIT_NODE 指定,未配则用主机名。用于中央看板区分是谁。
//   - 账号来自 CLI 的 --account;未指定记为 "default"。写日志失败绝不影响主流程。

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

let currentAccount = 'default';
let currentOperation = '';

/** 本次运行待上报的审计行缓冲(进程退出前一次性 flush)。 */
const uploadBuffer: string[] = [];

/** 设置当前请求归属的账号(店铺);CLI 启动时按 --account 设置一次。 */
export function setAuditAccount(account: string | undefined): void {
  const a = account?.trim();
  currentAccount = a && a.length > 0 ? a : 'default';
}

/** 设置当前操作名(如 "orders list");框架在执行每个命令前设置。 */
export function setAuditOperation(operation: string): void {
  currentOperation = operation;
}

/** 机器/同事标识:AMZ_AUDIT_NODE 优先,否则用主机名。 */
export function auditNode(): string {
  const n = process.env['AMZ_AUDIT_NODE']?.trim();
  return n && n.length > 0 ? n : hostname();
}

/** 本地落盘是否启用及日志根目录;AMZ_AUDIT_DISABLE=1/true 关闭。 */
function auditBaseDir(): string | undefined {
  const disabled = (process.env['AMZ_AUDIT_DISABLE'] ?? '').trim().toLowerCase();
  if (disabled === '1' || disabled === 'true') return undefined;
  const custom = process.env['AMZ_AUDIT_DIR']?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), '.amz-cli', 'audit');
}

/** 账号名转成安全的文件夹名(防路径穿越/非法字符)。 */
export function sanitizeAccountForPath(account: string): string {
  const cleaned = account.replace(/[^A-Za-z0-9_.-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'default';
}

export interface AuditRecord {
  /** 接口体系:SP-API 或 Ads API */
  api: 'sp' | 'ads';
  method: string;
  /** 请求路径(不含 query,避免带上 ASIN/订单号等) */
  path: string;
  region?: string;
  status?: number;
  ok: boolean;
  /** 失败时的类型化 subtype(不含任何 PII) */
  errorSubtype?: string;
}

/** 组装一行审计记录的 JSON(纯函数,便于单测)。 */
export function buildAuditLine(
  rec: AuditRecord,
  account: string,
  node: string,
  operation: string,
  isoTimestamp: string,
): string {
  return JSON.stringify({
    ts: isoTimestamp,
    account,
    node,
    ...(operation ? { op: operation } : {}),
    api: rec.api,
    method: rec.method,
    path: rec.path,
    ...(rec.region ? { region: rec.region } : {}),
    ...(rec.status !== undefined ? { status: rec.status } : {}),
    ok: rec.ok,
    ...(rec.errorSubtype ? { error: rec.errorSubtype } : {}),
  });
}

/** 记录一条审计日志:本地落盘(按账号/月) + 入上报缓冲。任何异常都吞掉。 */
export function auditLog(rec: AuditRecord): void {
  let line: string;
  try {
    line = buildAuditLine(rec, currentAccount, auditNode(), currentOperation, new Date().toISOString());
  } catch {
    return;
  }
  // 本地落盘
  const base = auditBaseDir();
  if (base) {
    try {
      const dir = join(base, sanitizeAccountForPath(currentAccount));
      mkdirSync(dir, { recursive: true });
      const month = line.slice(7, 14); // 从 "ts":"YYYY-MM... 里取 YYYY-MM(容错,失败见 catch)
      const monthKey = /"ts":"(\d{4}-\d{2})/.exec(line)?.[1] ?? month;
      appendFileSync(join(dir, `${monthKey}.log`), line + '\n', 'utf8');
    } catch {
      // 本地写失败不影响业务,也不影响上报。
    }
  }
  // 入上报缓冲(配了中央地址才最终 flush)
  if (process.env['AMZ_AUDIT_HTTP']?.trim()) {
    uploadBuffer.push(line);
    // 常驻进程(如多服务器长期发请求)不能只等退出:攒够一批就先异步发一批。
    if (uploadBuffer.length >= UPLOAD_BATCH_THRESHOLD) void flushAuditUploads();
  }
}

/** 缓冲攒到这个条数就先发一批(兼顾常驻进程与一次性命令)。 */
const UPLOAD_BATCH_THRESHOLD = 50;

/**
 * 进程退出前把本次运行的审计行一次性上报到中央服务器(若配置了 AMZ_AUDIT_HTTP)。
 * 短超时、失败即忽略——上报是旁路,本地文件是底账,绝不拖慢或阻断命令。
 */
export async function flushAuditUploads(): Promise<void> {
  const url = process.env['AMZ_AUDIT_HTTP']?.trim();
  if (!url || uploadBuffer.length === 0) return;
  const token = process.env['AMZ_AUDIT_TOKEN']?.trim();
  const body = uploadBuffer.join('\n'); // ndjson
  uploadBuffer.length = 0;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // 上报失败不影响命令结果;本地文件仍有完整记录。
  }
}
