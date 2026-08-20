import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COUNTRY_TO_REGION, parseMintRegion } from '../protocol.mjs';

test('显式 region 优先,忽略 marketplace', () => {
  assert.deepEqual(parseMintRegion({ region: 'EU', marketplace: 'US' }), { region: 'eu' });
});

test('marketplace 国家码映射:含欧洲扩展站与 FE', () => {
  assert.deepEqual(parseMintRegion({ marketplace: 'US' }), { region: 'na' });
  assert.deepEqual(parseMintRegion({ marketplace: 'pl' }), { region: 'eu' });
  assert.deepEqual(parseMintRegion({ marketplace: 'GB' }), { region: 'eu' });
  assert.deepEqual(parseMintRegion({ marketplace: 'JP' }), { region: 'fe' });
});

test('认不出的 marketplace 报错,绝不静默回落到 na', () => {
  assert.deepEqual(parseMintRegion({ marketplace: 'XX' }), {
    error: 'unknown_marketplace',
    detail: 'XX',
  });
});

test('region 与 marketplace 都缺省时默认 na', () => {
  assert.deepEqual(parseMintRegion({}), { region: 'na' });
});

test('映射表覆盖 CLI regions.ts 的全部国家码', () => {
  const expected = [
    'US', 'CA', 'MX', 'BR',
    'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'BE', 'IE', 'TR', 'AE', 'SA', 'EG', 'IN', 'ZA',
    'JP', 'AU', 'SG',
  ];
  for (const c of expected) {
    assert.ok(COUNTRY_TO_REGION[c], `缺少 ${c}`);
  }
});
