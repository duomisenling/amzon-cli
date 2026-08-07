// 代理支持测试 —— 起一个真的 CONNECT 代理和一个真的目标服务器,
// 验证请求确实"走了代理"还是"直连了",而不是只检查配置读没读到。
//
// 最要紧的一条是 fail-closed:代理不通时必须报错,且目标服务器**一次都没被访问**。
// 如果哪天有人给它加了"代理失败就直连"的兜底,那条用例会立刻红。

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { afterEach, test } from 'node:test';
import { spawn } from 'node:child_process';
import {
  amazonFetch,
  closeEgressAgents,
  egressLabel,
  egressStatus,
  redactProxy,
} from '../dist/internal/net/egress.js';
import { buildAuditLine } from '../dist/internal/audit.js';

const ENV_KEYS = ['SP_API_PROXY', 'ADS_PROXY', 'EGRESS_LABEL'];
const servers = [];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(async () => {
  clearEnv();
  await closeEgressAgents();
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** 目标服务器:记录被访问了几次。 */
async function startTarget() {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TARGET_OK');
  });
  const port = await listen(server);
  return { state, port, url: `http://127.0.0.1:${port}/probe` };
}

/** 最小 CONNECT 代理:记录每次 CONNECT 的目标和 Proxy-Authorization 头,然后原样转发。 */
async function startProxy() {
  const state = { connects: [], auth: [] };
  const server = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end('expected CONNECT');
  });
  server.on('connect', (req, clientSocket, head) => {
    state.connects.push(req.url);
    state.auth.push(req.headers['proxy-authorization'] ?? null);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const port = await listen(server);
  return { state, port };
}

/** 拿一个确定没人监听的端口:先占后放。 */
async function deadPort() {
  const server = http.createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ───────────────────────────────── 直连(向后兼容)

test('没配代理时等同于直连:目标被访问,不经任何代理', async () => {
  const target = await startTarget();
  const proxy = await startProxy();

  const resp = await amazonFetch(target.url, {}, 'sp');
  assert.equal(await resp.text(), 'TARGET_OK');
  assert.equal(target.state.hits, 1);
  assert.equal(proxy.state.connects.length, 0, '没配代理却走了代理');
});

// ───────────────────────────────── 走代理

test('配了 SP_API_PROXY 时请求经代理发出', async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  process.env.SP_API_PROXY = `http://127.0.0.1:${proxy.port}`;

  const resp = await amazonFetch(target.url, {}, 'sp');
  assert.equal(await resp.text(), 'TARGET_OK');
  assert.equal(proxy.state.connects.length, 1, '请求没有经过代理');
  assert.match(proxy.state.connects[0], new RegExp(`:${target.port}$`));
});

test('代理地址里的用户名密码会变成 Proxy-Authorization 头', async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  process.env.SP_API_PROXY = `http://entity-a:s3cret@127.0.0.1:${proxy.port}`;

  await amazonFetch(target.url, {}, 'sp');
  const auth = proxy.state.auth[0];
  assert.ok(auth?.startsWith('Basic '), `期望 Basic 认证头,实际:${auth}`);
  assert.equal(
    Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8'),
    'entity-a:s3cret',
  );
});

// ───────────────────────────────── fail-closed(最关键的一条)

test('代理连不上时必须报错,且绝不回退直连', async () => {
  const target = await startTarget();
  const dead = await deadPort();
  process.env.SP_API_PROXY = `http://127.0.0.1:${dead}`;
  process.env.EGRESS_LABEL = 'entity-a';

  await assert.rejects(
    () => amazonFetch(target.url, {}, 'sp'),
    (err) => {
      // 报错要能一眼看出是代理不可用,而不是笼统的网络错误
      assert.match(err.message, /经代理/);
      assert.match(err.message, /entity-a/);
      assert.match(err.message, /未回退直连/);
      return true;
    },
  );

  // 这一条才是重点:回退直连会静默绕过既定的网络配置,而且没人会发现
  assert.equal(target.state.hits, 0, '代理失败后竟然直连了目标');
});

test('报错信息里不含代理密码', async () => {
  const target = await startTarget();
  const dead = await deadPort();
  process.env.SP_API_PROXY = `http://entity-a:sup3rs3cret@127.0.0.1:${dead}`;

  await assert.rejects(
    () => amazonFetch(target.url, {}, 'sp'),
    (err) => {
      assert.equal(err.message.includes('sup3rs3cret'), false, '报错信息泄漏了代理密码');
      return true;
    },
  );
});

// ───────────────────────────────── 广告通道回退规则

test('ADS_PROXY 留空时广告请求复用 SP_API_PROXY', async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  process.env.SP_API_PROXY = `http://127.0.0.1:${proxy.port}`;

  await amazonFetch(target.url, {}, 'ads');
  assert.equal(proxy.state.connects.length, 1, '广告请求没有复用 SP_API_PROXY');
});

test('ADS_PROXY 配了就用它自己的,不用 SP_API_PROXY', async () => {
  const target = await startTarget();
  const spProxy = await startProxy();
  const adsProxy = await startProxy();
  process.env.SP_API_PROXY = `http://127.0.0.1:${spProxy.port}`;
  process.env.ADS_PROXY = `http://127.0.0.1:${adsProxy.port}`;

  await amazonFetch(target.url, {}, 'ads');
  assert.equal(adsProxy.state.connects.length, 1, '广告请求没走 ADS_PROXY');
  assert.equal(spProxy.state.connects.length, 0, '广告请求错走了 SP_API_PROXY');

  await amazonFetch(target.url, {}, 'sp');
  assert.equal(spProxy.state.connects.length, 1, 'SP 请求没走 SP_API_PROXY');
  assert.equal(adsProxy.state.connects.length, 1, 'SP 请求错走了 ADS_PROXY');
});

// ───────────────────────────────── 配置错误(发请求之前就拦住)

test('代理地址格式不对时报类型化参数错误,不发出任何请求', async () => {
  const target = await startTarget();
  process.env.SP_API_PROXY = '这不是一个地址';

  await assert.rejects(
    () => amazonFetch(target.url, {}, 'sp'),
    (err) => {
      assert.equal(err.subtype, 'egress.invalid_proxy_url');
      assert.equal(err.param, 'SP_API_PROXY');
      return true;
    },
  );
  assert.equal(target.state.hits, 0);
});

test('不支持的代理协议(如 socks5)被明确拒绝', async () => {
  const target = await startTarget();
  process.env.SP_API_PROXY = 'socks5://127.0.0.1:1080';

  await assert.rejects(
    () => amazonFetch(target.url, {}, 'sp'),
    (err) => {
      assert.equal(err.subtype, 'egress.unsupported_proxy_scheme');
      return true;
    },
  );
  assert.equal(target.state.hits, 0);
});

// ───────────────────────────────── 不泄漏密码

test('redactProxy 只保留协议和主机,去掉用户名密码', () => {
  assert.equal(redactProxy('http://user:pass@1.2.3.4:38128'), 'http://1.2.3.4:38128');
  assert.equal(redactProxy('https://a:b@proxy.example.com'), 'https://proxy.example.com');
  assert.equal(redactProxy('乱七八糟'), '(代理地址无法解析)');
});

test('egressStatus 不含密码,并标出广告是否复用 SP 的代理', () => {
  process.env.SP_API_PROXY = 'http://proxyuser:topsecret@1.2.3.4:38128';
  process.env.EGRESS_LABEL = 'entity-a';

  const s = egressStatus();
  assert.equal(JSON.stringify(s).includes('topsecret'), false, 'egressStatus 泄漏了密码');
  assert.equal(s.label, 'entity-a');
  assert.equal(s.sp.configured, true);
  assert.equal(s.sp.proxy, 'http://1.2.3.4:38128');
  assert.equal(s.ads.configured, true);
  assert.equal(s.ads.inheritsFromSp, true, '未配 ADS_PROXY 时应标记为复用 SP 的');

  process.env.ADS_PROXY = 'http://proxyuser:other@5.6.7.8:38128';
  assert.equal(egressStatus().ads.inheritsFromSp, false);
});

test('egressLabel 未配置时返回 undefined,空白串也算未配置', () => {
  assert.equal(egressLabel(), undefined);
  process.env.EGRESS_LABEL = '   ';
  assert.equal(egressLabel(), undefined);
  process.env.EGRESS_LABEL = 'entity-b';
  assert.equal(egressLabel(), 'entity-b');
});

// ───────────────────────────────── 进程必须能退出

test('代理无响应时关闭连接池必须立刻返回,不能等在途连接', async () => {
  // 这条覆盖的是"代理挂了"那条路:优雅关闭(close)会等待在途连接结束,
  // 而被防火墙丢包的连接永远不会结束 —— 于是命令跑完卡死,
  // 恰恰发生在最需要看到报错的时候。必须用强制关闭(destroy)。
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s)); // 接受连接,但永不响应
  const port = await listen(silent);
  process.env.SP_API_PROXY = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(() =>
      amazonFetch('http://127.0.0.1:9/probe', { signal: AbortSignal.timeout(1000) }, 'sp'),
    );

    const t0 = Date.now();
    await closeEgressAgents();
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `关闭连接池用了 ${ms}ms —— 说明在等一个永远不会结束的连接`);
  } finally {
    for (const s of sockets) s.destroy();
  }
});

test('配了代理的命令跑完后进程能自己退出(连接池已关闭)', async () => {
  // ProxyAgent 的连接池会占住事件循环。忘记关的话,命令逻辑早就跑完了、
  // 进程却一直不退,表现是"命令卡住没反应",而且日志上完全看不出原因。
  const target = await startTarget();
  const proxy = await startProxy();
  const child = spawn(
    process.execPath,
    ['dist/cli.js', 'doctor', 'egress', '--skip-restriction-check'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SP_API_PROXY: `http://127.0.0.1:${proxy.port}`,
        EGRESS_LABEL: 'test',
        // 探测走本地假服务,不依赖外网
        AMZ_EGRESS_PROBE_URL: target.url,
      },
      stdio: 'ignore',
    },
  );

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 25_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  assert.equal(exited, true, '命令跑完了但进程没退出 —— 出口代理的连接池没关');
});

// ───────────────────────────────── 审计日志

test('审计行带 egress 标签,便于核对账号走的是预期的出口', () => {
  const line = buildAuditLine(
    { api: 'sp', method: 'GET', path: '/orders/v0/orders', ok: true, status: 200 },
    'Proxy Shop',
    'zhangsan-PC',
    'orders list',
    '2026-08-03T00:00:00.000Z',
    'entity-a',
  );
  assert.equal(JSON.parse(line).egress, 'entity-a');
});

test('未配出口时审计行不带 egress 字段(不污染既有日志格式)', () => {
  const line = buildAuditLine(
    { api: 'sp', method: 'GET', path: '/orders/v0/orders', ok: true, status: 200 },
    'DirectShop',
    'zhangsan-PC',
    'orders list',
    '2026-08-03T00:00:00.000Z',
  );
  assert.equal('egress' in JSON.parse(line), false);
});
