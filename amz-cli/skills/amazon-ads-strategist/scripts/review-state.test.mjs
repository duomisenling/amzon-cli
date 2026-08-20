import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-state.mjs');

function run(dir, ...args) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args, '--state-dir', dir], { encoding: 'utf8' }));
}

test('creates a 1-ASIN review and exposes only the next due checkpoint', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-review-'));
  try {
    const created = run(dir, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'B012345678', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'bid adjustment');
    assert.equal(created.account, 'shop-a');
    assert.deepEqual(created.checkpoints.map((item) => item.day), [3, 7, 14]);
    assert.deepEqual(run(dir, 'due', '--now', '2026-08-04T00:00:00Z').map((item) => item.day), [3]);
    run(dir, 'complete', '--id', created.id, '--day', '3', '--result', 'stable');
    assert.deepEqual(run(dir, 'due', '--now', '2026-08-08T00:00:00Z').map((item) => item.day), [7]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps accounts separate and accepts exactly 20 ASINs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-review-'));
  try {
    const first = run(dir, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'B012345678', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'a');
    const second = run(dir, 'create', '--account', 'shop-b', '--marketplace', 'JP', '--asins', 'B087654321', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'b');
    assert.notEqual(first.id, second.id);
    assert.equal(run(dir, 'show', '--id', first.id).account, 'shop-a');
    assert.equal(run(dir, 'show', '--id', second.id).account, 'shop-b');
    const twenty = Array.from({ length: 20 }, (_, index) => `B${String(index).padStart(9, '0')}`).join(',');
    assert.equal(run(dir, 'create', '--account', 'shop-c', '--marketplace', 'DE', '--asins', twenty, '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'batch').asins.length, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid ASINs and out-of-order completion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-review-'));
  try {
    const invalid = spawnSync(process.execPath, [script, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'bad', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'bad', '--state-dir', dir], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid ASIN/);
    const twentyOne = Array.from({ length: 21 }, (_, index) => `B${String(index).padStart(9, '0')}`).join(',');
    const tooMany = spawnSync(process.execPath, [script, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', twentyOne, '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'too many', '--state-dir', dir], { encoding: 'utf8' });
    assert.notEqual(tooMany.status, 0);
    assert.match(tooMany.stderr, /1-20 ASINs/);
    const created = run(dir, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'B012345678', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'valid');
    const outOfOrder = spawnSync(process.execPath, [script, 'complete', '--id', created.id, '--day', '7', '--result', 'skip', '--state-dir', dir], { encoding: 'utf8' });
    assert.notEqual(outOfOrder.status, 0);
    assert.match(outOfOrder.stderr, /expected 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('low-volume cadence uses 7/30/90 and completes at the last node', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-review-'));
  try {
    const created = run(dir, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'B012345678', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'low volume test', '--cadence', 'low-volume');
    assert.equal(created.cadence, 'low-volume');
    assert.deepEqual(created.checkpoints.map((item) => item.day), [7, 30, 90]);
    // 第3天不该到期:长尾品这时候还没有可判断的点击样本
    assert.deepEqual(run(dir, 'due', '--now', '2026-08-04T00:00:00Z'), []);
    const due = run(dir, 'due', '--now', '2026-08-09T00:00:00Z');
    assert.deepEqual(due.map((item) => item.day), [7]);
    assert.equal(due[0].cadence, 'low-volume');
    run(dir, 'complete', '--id', created.id, '--day', '7', '--result', 'no runaway spend');
    run(dir, 'complete', '--id', created.id, '--day', '30', '--result', 'half of click threshold');
    assert.equal(run(dir, 'show', '--id', created.id).status, 'applied');
    assert.equal(run(dir, 'complete', '--id', created.id, '--day', '90', '--result', 'threshold reached').status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default cadence stays 3/7/14 and rejects a foreign day', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-review-'));
  try {
    const created = run(dir, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'B012345678', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'default');
    assert.equal(created.cadence, 'default');
    assert.deepEqual(created.checkpoints.map((item) => item.day), [3, 7, 14]);
    const wrongDay = spawnSync(process.execPath, [script, 'complete', '--id', created.id, '--day', '30', '--result', 'nope', '--state-dir', dir], { encoding: 'utf8' });
    assert.notEqual(wrongDay.status, 0);
    assert.match(wrongDay.stderr, /--day must be one of: 3, 7, 14/);
    const badCadence = spawnSync(process.execPath, [script, 'create', '--account', 'shop-a', '--marketplace', 'US', '--asins', 'B012345678', '--applied-at', '2026-08-01T00:00:00Z', '--summary', 'bad', '--cadence', 'weekly', '--state-dir', dir], { encoding: 'utf8' });
    assert.notEqual(badCadence.status, 0);
    assert.match(badCadence.stderr, /--cadence must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
