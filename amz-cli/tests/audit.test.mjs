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
  assert.equal(sanitizeAccountForPath('Animal Abode'), 'Animal_Abode');
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
