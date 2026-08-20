import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKETPLACES, marketplaceByCountry, marketplaceById } from '../dist/internal/client/regions.js';
import { resolveMarketplace } from '../dist/shortcuts/common.js';

test('EU 扩展站已收录:PL/NL/SE/BE/TR 国家码可解析,区域与币种正确', () => {
  assert.deepEqual(resolveMarketplace('PL'), {
    id: 'A1C3SOZRARQ6R3', country: 'PL', region: 'eu', name: 'Amazon.pl', currency: 'PLN',
  });
  assert.equal(resolveMarketplace('nl').region, 'eu');
  assert.equal(resolveMarketplace('SE').currency, 'SEK');
  assert.equal(resolveMarketplace('BE').id, 'AMEN7PMS3EDWL');
  assert.equal(resolveMarketplace('TR').currency, 'TRY');
});

test('FE 站点已收录:JP/AU/SG 走 fe 区域', () => {
  assert.equal(resolveMarketplace('JP').region, 'fe');
  assert.equal(resolveMarketplace('AU').region, 'fe');
  assert.equal(resolveMarketplace('SG').id, 'A19VAU5U5O7RUS');
});

test('GB 是 UK 的别名;直接传 marketplaceId 也能解析', () => {
  assert.equal(marketplaceByCountry('gb')?.country, 'UK');
  assert.equal(resolveMarketplace('A1C3SOZRARQ6R3').country, 'PL');
});

test('不认识的市场仍报 unknown_marketplace,提示里带全部国家码', () => {
  assert.throws(
    () => resolveMarketplace('XX'),
    (err) => err?.subtype === 'unknown_marketplace' && err.hintHuman.includes('PL'),
  );
});

test('表内 marketplaceId 与国家码一一对应,无重复', () => {
  assert.equal(new Set(MARKETPLACES.map((m) => m.id)).size, MARKETPLACES.length);
  assert.equal(new Set(MARKETPLACES.map((m) => m.country)).size, MARKETPLACES.length);
  for (const m of MARKETPLACES) assert.equal(marketplaceById(m.id), m);
});
