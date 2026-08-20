import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-state.mjs');

function run(dir, ...args) {
  return JSON.parse(
    execFileSync(process.execPath, [script, ...args, '--state-dir', dir], { encoding: 'utf8' }),
  );
}

function create(dir, id, account, asins) {
  return run(
    dir,
    'create',
    '--scan-id', id,
    '--account', account,
    '--marketplace', 'US',
    '--as-of', '2026-08-13',
    '--asins', asins,
    '--total-candidates', String(asins.split(',').length),
  );
}

test('new scan is idempotent and next returns at most the requested ready items', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-screening-'));
  try {
    const created = create(dir, 'scan-one', 'shop-a', 'B000000001,B000000002,B000000003');
    assert.deepEqual(created.items.map((item) => item.status), ['new', 'new', 'new']);
    assert.deepEqual(create(dir, 'scan-one', 'shop-a', 'B000000001').items, created.items);
    const next = run(dir, 'next', '--scan-id', 'scan-one', '--limit', '2');
    assert.equal(next.count, 2);
    assert.equal(next.remaining, 3);
    assert.deepEqual(next.items.map((item) => item.asin), ['B000000001', 'B000000002']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same scan can append a later CLI offset page without duplicating ASINs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-screening-'));
  try {
    create(dir, 'scan-one', 'shop-a', 'B000000001,B000000002');
    const merged = run(
      dir,
      'create',
      '--scan-id', 'scan-one',
      '--account', 'shop-a',
      '--marketplace', 'US',
      '--as-of', '2026-08-13',
      '--asins', 'B000000002,B000000003',
      '--offset', '2',
      '--total-candidates', '4',
    );
    assert.deepEqual(merged.items.map((item) => item.asin), [
      'B000000001',
      'B000000002',
      'B000000003',
    ]);
    assert.deepEqual(merged.items.map((item) => item.rank), [1, 2, 4]);
    assert.equal(merged.totalCandidates, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('later scans preserve applied/reviewing and blocked items while continuing untreated ASINs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-screening-'));
  try {
    create(dir, 'scan-one', 'shop-a', 'B000000001,B000000002,B000000003');
    run(dir, 'mark', '--scan-id', 'scan-one', '--asins', 'B000000001', '--status', 'applied');
    run(dir, 'mark', '--scan-id', 'scan-one', '--asins', 'B000000002', '--status', 'blocked', '--note', 'no buy box');
    const second = create(
      dir,
      'scan-two',
      'shop-a',
      'B000000001,B000000002,B000000003,B000000004',
    );
    assert.deepEqual(second.items.map((item) => item.status), [
      'reviewing',
      'blocked',
      'continued',
      'new',
    ]);
    assert.deepEqual(
      run(dir, 'next', '--scan-id', 'scan-two').items.map((item) => item.asin),
      ['B000000003', 'B000000004'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan history is isolated by account and marketplace', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-screening-'));
  try {
    create(dir, 'scan-shop-a', 'shop-a', 'B000000001');
    run(dir, 'mark', '--scan-id', 'scan-shop-a', '--asins', 'B000000001', '--status', 'blocked');
    const other = create(dir, 'scan-shop-b', 'shop-b', 'B000000001');
    assert.equal(other.items[0].status, 'new');
    assert.equal(run(dir, 'latest', '--account', 'shop-a', '--marketplace', 'US').id, 'scan-shop-a');
    assert.equal(run(dir, 'latest', '--account', 'shop-b', '--marketplace', 'US').id, 'scan-shop-b');

    create(dir, 'shared-scan-id', 'shop-a', 'B000000002');
    create(dir, 'shared-scan-id', 'shop-b', 'B000000002');
    const ambiguous = spawnSync(
      process.execPath,
      [script, 'next', '--scan-id', 'shared-scan-id', '--state-dir', dir],
      { encoding: 'utf8' },
    );
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /exists in multiple stores/);
    assert.equal(
      run(
        dir,
        'next',
        '--scan-id', 'shared-scan-id',
        '--account', 'shop-b',
        '--marketplace', 'US',
      ).account,
      'shop-b',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts 100 scan candidates, rejects invalid mark status and foreign ASINs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ads-screening-'));
  try {
    const hundred = Array.from({ length: 100 }, (_, index) =>
      `B${String(index).padStart(9, '0')}`,
    ).join(',');
    assert.equal(create(dir, 'scan-large', 'shop-a', hundred).items.length, 100);
    const invalidStatus = spawnSync(
      process.execPath,
      [script, 'mark', '--scan-id', 'scan-large', '--asins', 'B000000001', '--status', 'new', '--state-dir', dir],
      { encoding: 'utf8' },
    );
    assert.notEqual(invalidStatus.status, 0);
    assert.match(invalidStatus.stderr, /status must be diagnosed/);
    const foreign = spawnSync(
      process.execPath,
      [script, 'mark', '--scan-id', 'scan-large', '--asins', 'Z999999999', '--status', 'deferred', '--state-dir', dir],
      { encoding: 'utf8' },
    );
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /not in screening/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
