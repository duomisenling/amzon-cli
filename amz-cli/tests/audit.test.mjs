import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuditLine,
  sanitizeAccountForPath,
  setAuditAccount,
  setAuditOperation,
  auditLog,
  flushAuditUploads,
} from '../dist/internal/audit.js';

const MONTH = new Date().toISOString().slice(0, 7); // YYYY-MM

test('buildAuditLine 记录关键字段(含 node),不含 PII', () => {
  const line = buildAuditLine(
    { api: 'sp', method: 'GET', path: '/orders/v0/orders', region: 'na', status: 200, ok: true },
    'Shop A',
    'zhangsan-PC',
    'orders list',
    '2026-07-31T00:00:00.000Z',
  );
  assert.deepEqual(JSON.parse(line), {
    ts: '2026-07-31T00:00:00.000Z',
    account: 'Shop A',
    node: 'zhangsan-PC',
    op: 'orders list',
    api: 'sp',
    method: 'GET',
    path: '/orders/v0/orders',
    region: 'na',
    status: 200,
    ok: true,
  });
});

test('sanitizeAccountForPath 清理非法字符', () => {
  assert.equal(sanitizeAccountForPath('Proxy Shop'), 'Proxy_Shop');
  assert.equal(sanitizeAccountForPath('../etc'), '.._etc');
  assert.equal(sanitizeAccountForPath(''), 'default');
});

test('auditLog 按账号分目录、按月分文件写入,并带 node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-audit-'));
  process.env.AMZ_AUDIT_DIR = dir;
  process.env.AMZ_AUDIT_NODE = 'test-node';
  delete process.env.AMZ_AUDIT_DISABLE;
  delete process.env.AMZ_AUDIT_HTTP;

  setAuditAccount('Shop A');
  setAuditOperation('inventory list');
  auditLog({ api: 'sp', method: 'GET', path: '/fba/inventory/v1/summaries', region: 'na', status: 200, ok: true });

  setAuditAccount('shop-b');
  setAuditOperation('ads coverage');
  auditLog({ api: 'ads', method: 'POST', path: '/sp/productAds/list', status: 200, ok: true });

  const a = JSON.parse(readFileSync(join(dir, 'Shop_A', `${MONTH}.log`), 'utf8').trim());
  assert.equal(a.account, 'Shop A');
  assert.equal(a.node, 'test-node');
  assert.equal(a.op, 'inventory list');
  assert.equal(a.path, '/fba/inventory/v1/summaries');
  assert.equal(a.ok, true);

  const b = JSON.parse(readFileSync(join(dir, 'shop-b', `${MONTH}.log`), 'utf8').trim());
  assert.equal(b.account, 'shop-b');
  assert.equal(b.api, 'ads');

  delete process.env.AMZ_AUDIT_DIR;
  delete process.env.AMZ_AUDIT_NODE;
});

test('AMZ_AUDIT_DISABLE=1 时不写本地日志', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-audit-off-'));
  process.env.AMZ_AUDIT_DIR = dir;
  process.env.AMZ_AUDIT_DISABLE = '1';
  setAuditAccount('Shop A');
  auditLog({ api: 'sp', method: 'GET', path: '/x', ok: true });
  assert.equal(existsSync(join(dir, 'Shop_A', `${MONTH}.log`)), false);
  delete process.env.AMZ_AUDIT_DISABLE;
  delete process.env.AMZ_AUDIT_DIR;
});

test('flushAuditUploads 未配 AMZ_AUDIT_HTTP 时安全返回(不抛)', async () => {
  delete process.env.AMZ_AUDIT_HTTP;
  await flushAuditUploads(); // 不应抛错
});

test('flushAuditUploads 把缓冲行 POST 到中央并清空缓冲(含 MCP 操作名)', async () => {
  process.env.AMZ_AUDIT_DISABLE = '1'; // 本测试只看上报,不落盘
  process.env.AMZ_AUDIT_HTTP = 'https://audit.example.test/ingest';
  process.env.AMZ_AUDIT_TOKEN = 'fake-audit-token';
  process.env.AMZ_AUDIT_NODE = 'test-node';
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), init });
    return new Response('ok');
  };
  try {
    setAuditAccount('shop-x');
    setAuditOperation('mcp apply_listing_update');
    auditLog({ api: 'sp', method: 'PATCH', path: '/listings/2021-08-01/items', status: 200, ok: true });
    await flushAuditUploads();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://audit.example.test/ingest');
    assert.equal(posts[0].init.headers.Authorization, 'Bearer fake-audit-token');
    const last = JSON.parse(posts[0].init.body.split('\n').at(-1));
    assert.equal(last.account, 'shop-x');
    assert.equal(last.op, 'mcp apply_listing_update');
    assert.equal(last.path, '/listings/2021-08-01/items');
    // 缓冲已清空:再 flush 一次不重复上报
    await flushAuditUploads();
    assert.equal(posts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AMZ_AUDIT_HTTP;
    delete process.env.AMZ_AUDIT_TOKEN;
    delete process.env.AMZ_AUDIT_DISABLE;
    delete process.env.AMZ_AUDIT_NODE;
  }
});

test('flushAuditUploads 失败时把该批回填缓冲,下次成功一并补发且不丢不重', async () => {
  process.env.AMZ_AUDIT_DISABLE = '1'; // 只看上报,不落盘
  process.env.AMZ_AUDIT_HTTP = 'https://audit.example.test/ingest';
  process.env.AMZ_AUDIT_NODE = 'test-node';
  const originalFetch = globalThis.fetch;
  const posts = [];
  let failNext = true;
  globalThis.fetch = async (_url, init) => {
    if (failNext) throw new Error('ECONNREFUSED (mock)');
    posts.push(init.body);
    return new Response('ok');
  };
  try {
    setAuditAccount('shop-x');
    setAuditOperation('orders list');
    auditLog({ api: 'sp', method: 'GET', path: '/audit-retry/first', ok: true });

    // 第一次 flush 失败:不抛错,批次回填缓冲而不是丢掉
    await flushAuditUploads();
    assert.equal(posts.length, 0);

    // 再攒一条,第二次 flush 成功:两批按原顺序一起发出去
    auditLog({ api: 'sp', method: 'GET', path: '/audit-retry/second', ok: true });
    failNext = false;
    await flushAuditUploads();
    assert.equal(posts.length, 1);
    const paths = posts[0].split('\n').map((line) => JSON.parse(line).path);
    assert.deepEqual(paths, ['/audit-retry/first', '/audit-retry/second']);

    // 补发成功后缓冲已清空:再 flush 不重复上报
    await flushAuditUploads();
    assert.equal(posts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AMZ_AUDIT_HTTP;
    delete process.env.AMZ_AUDIT_DISABLE;
    delete process.env.AMZ_AUDIT_NODE;
  }
});
