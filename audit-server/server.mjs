// amz-cli 审计日志中央接收端 + 网页看板(纯 Node,无第三方依赖,无原生模块)
//
// 两个用途:
//   1) 接收:各服务器/同事机器上的 amz-cli 把审计行 POST 到这里(Bearer AUDIT_TOKEN 校验)。
//   2) 查看:浏览器打开本服务,登录后按 店铺/同事/月份/状态 筛选看表格,可导出 CSV。
//
// 存储:JSONL 文件,按店铺+月份分文件 <DATA_DIR>/<账号>/<YYYY-MM>.jsonl(一行一条)。
// 只存"访问了什么"的元数据,不含任何买家 PII。
//
// 配置(环境变量):
//   PORT               监听端口,默认 8080
//   AUDIT_TOKEN        接收上报用的密钥(CLI 端 AMZ_AUDIT_TOKEN 要与此一致);必填
//   DASHBOARD_PASSWORD 看板登录密码;必填
//   AUDIT_DATA_DIR     数据目录,默认 ./data(部署时挂持久卷)
//   SESSION_SECRET     会话签名密钥,默认由密码派生(建议单独设一个随机串)

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const AUDIT_TOKEN = (process.env.AUDIT_TOKEN || '').trim();
const DASHBOARD_PASSWORD = (process.env.DASHBOARD_PASSWORD || '').trim();
const DATA_DIR = (process.env.AUDIT_DATA_DIR || './data').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || DASHBOARD_PASSWORD || 'change-me').trim();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 登录有效期 7 天

if (!AUDIT_TOKEN || !DASHBOARD_PASSWORD) {
  console.error('启动失败:必须设置 AUDIT_TOKEN 和 DASHBOARD_PASSWORD 环境变量。');
  process.exit(1);
}

// ---------- 工具 ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function sanitizeAccount(a) {
  const c = String(a || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return c.length ? c : 'default';
}
function monthOf(iso) {
  const m = /^(\d{4}-\d{2})/.exec(String(iso || ''));
  return m ? m[1] : new Date().toISOString().slice(0, 7);
}

// ---------- 会话(签名 cookie) ----------
function issueSession() {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}
function verifySession(token) {
  if (!token) return false;
  const [expStr, sig] = String(token).split('.');
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expect = createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
  return safeEqual(sig, expect);
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  return verifySession(parseCookies(req).sess);
}

// ---------- 存储:写入 ----------
function appendRecords(lines) {
  // 按 账号+月份 分组批量落盘,减少写次数;每组一次 appendFileSync(O_APPEND 原子)。
  const groups = new Map();
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const account = sanitizeAccount(obj.account);
    const month = monthOf(obj.ts);
    const key = `${account}/${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(JSON.stringify(obj)); // 归一化,防止塞进乱七八糟的行
  }
  for (const [key, arr] of groups) {
    const [account, month] = key.split('/');
    const dir = join(DATA_DIR, account);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${month}.jsonl`), arr.join('\n') + '\n', 'utf8');
  }
}

// ---------- 存储:读取查询 ----------
function listAccounts() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
function listMonths() {
  const months = new Set();
  for (const acc of listAccounts()) {
    const dir = join(DATA_DIR, acc);
    for (const f of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2})\.jsonl$/.exec(f);
      if (m) months.add(m[1]);
    }
  }
  return [...months].sort().reverse();
}
function readMonth(account, month) {
  const file = join(DATA_DIR, sanitizeAccount(account), `${month}.jsonl`);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 忽略坏行 */ }
  }
  return out;
}
function queryLogs({ account, node, month, status, q, limit }) {
  const mon = month || (listMonths()[0] ?? new Date().toISOString().slice(0, 7));
  const accounts = account ? [account] : listAccounts();
  let rows = [];
  for (const acc of accounts) rows.push(...readMonth(acc, mon));
  if (node) rows = rows.filter((r) => String(r.node || '') === node);
  if (status === 'ok') rows = rows.filter((r) => r.ok === true);
  else if (status === 'fail') rows = rows.filter((r) => r.ok === false);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) =>
      `${r.op || ''} ${r.path || ''} ${r.account || ''} ${r.node || ''}`.toLowerCase().includes(needle),
    );
  }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const total = rows.length;
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  return { month: mon, total, rows: rows.slice(0, lim) };
}
function distinctNodes(month) {
  const mon = month || (listMonths()[0] ?? new Date().toISOString().slice(0, 7));
  const set = new Set();
  for (const acc of listAccounts()) for (const r of readMonth(acc, mon)) if (r.node) set.add(String(r.node));
  return [...set].sort();
}

// ---------- HTTP 响应工具 ----------
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function sendJson(res, code, obj, headers = {}) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}
function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function toCsv(rows) {
  const cols = ['ts', 'account', 'node', 'op', 'api', 'method', 'path', 'region', 'status', 'ok', 'error'];
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  return lines.join('\n');
}

// ---------- 路由 ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (path === '/health') return send(res, 200, 'ok');

    // 上报接收
    if (path === '/audit' && req.method === 'POST') {
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(auth, AUDIT_TOKEN)) return send(res, 401, 'unauthorized');
      const body = await readBody(req);
      const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
      appendRecords(lines);
      return send(res, 204, '');
    }

    // 登录
    if (path === '/login' && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      let pwd = '';
      try { pwd = JSON.parse(body).password || ''; } catch { pwd = new URLSearchParams(body).get('password') || ''; }
      if (!safeEqual(pwd, DASHBOARD_PASSWORD)) return sendJson(res, 401, { ok: false });
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `sess=${issueSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
    }
    if (path === '/logout') {
      return send(res, 302, '', { 'Set-Cookie': 'sess=; HttpOnly; Path=/; Max-Age=0', Location: '/' });
    }

    // 看板首页(未登录给登录页)
    if (path === '/' && req.method === 'GET') {
      return send(res, 200, isAuthed(req) ? DASHBOARD_HTML : LOGIN_HTML, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }

    // 以下 API 需登录
    if (path.startsWith('/api/') || path === '/export.csv') {
      if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: '未登录' });
      const p = Object.fromEntries(url.searchParams);
      if (path === '/api/facets') {
        return sendJson(res, 200, { accounts: listAccounts(), months: listMonths(), nodes: distinctNodes(p.month) });
      }
      if (path === '/api/logs') {
        return sendJson(res, 200, queryLogs(p));
      }
      if (path === '/export.csv') {
        const { rows } = queryLogs({ ...p, limit: 5000 });
        return send(res, 200, toCsv(rows), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit_${p.account || 'all'}_${p.month || 'latest'}.csv"`,
        });
      }
    }

    return send(res, 404, 'not found');
  } catch (err) {
    return send(res, 500, 'server error');
  }
});

server.listen(PORT, () => {
  console.log(`amz-cli 审计接收端 + 看板已启动,端口 ${PORT},数据目录 ${DATA_DIR}`);
});

// ---------- 页面(内联,无需构建) ----------
const LOGIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>审计日志登录</title>
<style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#1e293b;padding:32px;border-radius:12px;width:300px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;margin-bottom:12px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}
.err{color:#f87171;font-size:13px;min-height:18px}</style></head><body>
<div class="card"><h1>amz-cli 审计日志</h1>
<input id="pw" type="password" placeholder="管理员密码" autofocus>
<div class="err" id="err"></div><button onclick="login()">登录</button></div>
<script>
async function login(){const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok)location.reload();else document.getElementById('err').textContent='密码不对';}
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>`;

const DASHBOARD_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>amz-cli 审计日志</title>
<style>
:root{color-scheme:dark}body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;margin:0}
header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;background:#1e293b;position:sticky;top:0}
header h1{font-size:16px;margin:0 12px 0 0}select,input{padding:7px 9px;border-radius:7px;border:1px solid #334155;background:#0f172a;color:#e2e8f0}
button,a.btn{padding:7px 12px;border:0;border-radius:7px;background:#2563eb;color:#fff;cursor:pointer;text-decoration:none;font-size:14px}
a.ghost{background:#334155}.muted{color:#94a3b8;font-size:13px;margin-left:auto}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1e293b;white-space:nowrap}
th{position:sticky;top:56px;background:#0f172a;color:#94a3b8}tr:hover{background:#1e293b}
.ok{color:#4ade80}.fail{color:#f87171}.wrap{padding:0 16px 40px}code{color:#a5b4fc}
</style></head><body>
<header>
<h1>📋 审计日志</h1>
<select id="account"><option value="">全部店铺</option></select>
<select id="node"><option value="">全部同事/机器</option></select>
<select id="month"></select>
<select id="status"><option value="">全部状态</option><option value="ok">仅成功</option><option value="fail">仅失败</option></select>
<input id="q" placeholder="搜索操作/接口" size="16">
<button onclick="load()">刷新</button>
<a class="btn ghost" id="csv" href="#">导出CSV</a>
<a class="btn ghost" href="/logout">退出</a>
<span class="muted" id="summary"></span>
</header>
<div class="wrap"><table><thead><tr>
<th>时间</th><th>店铺</th><th>同事/机器</th><th>操作</th><th>接口</th><th>区域</th><th>状态</th>
</tr></thead><tbody id="rows"></tbody></table></div>
<script>
const $=id=>document.getElementById(id);
function qs(){const p=new URLSearchParams();for(const k of['account','node','month','status','q']){const v=$(k).value;if(v)p.set(k,v);}return p;}
async function facets(){const f=await(await fetch('/api/facets')).json();
for(const a of f.accounts)$('account').append(new Option(a,a));
for(const n of f.nodes)$('node').append(new Option(n,n));
$('month').innerHTML='';for(const m of f.months)$('month').append(new Option(m,m));}
function td(t,cls){const e=document.createElement('td');e.textContent=t??'';if(cls)e.className=cls;return e;}
async function load(){const p=qs();$('csv').href='/export.csv?'+p.toString();
const d=await(await fetch('/api/logs?'+p.toString())).json();
$('summary').textContent=(d.month||'')+' · 共 '+d.total+' 条'+(d.total>d.rows.length?'（显示前 '+d.rows.length+'）':'');
const tb=$('rows');tb.innerHTML='';
for(const r of d.rows){const tr=document.createElement('tr');
tr.append(td((r.ts||'').replace('T',' ').replace(/\\..*/,'')),td(r.account),td(r.node),td(r.op),td(r.path),td(r.region||''),
td((r.ok?'✅ ':'⚠️ ')+(r.status??(r.error||'')),r.ok?'ok':'fail'));tb.append(tr);}}
['account','node','month','status'].forEach(k=>$(k).addEventListener('change',load));
$('q').addEventListener('keydown',e=>{if(e.key==='Enter')load();});
(async()=>{await facets();await load();})();
</script></body></html>`;
