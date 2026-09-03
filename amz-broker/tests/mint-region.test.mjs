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

test('显式 region 必须在白名单内,原型链属性不能冒充区域', () => {
  // 真正没校验的是 region 这条路径:它只做 toLowerCase 就原样返回,
  // 而 SP_ENDPOINTS['constructor'] 是 truthy —— 旧版能一路穿到下游拼端点。
  // (marketplace 那条路径因为 toUpperCase 过,原型属性名全是小写,本来就撞不上,
  //  拿它测防护是个必过的假测试,所以这里改测 region。)
  for (const bogus of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const out = parseMintRegion({ region: bogus });
    assert.equal(out.error, 'invalid_region', `region=${bogus} 应被拒绝`);
    assert.equal(out.region, undefined);
  }
  // 合法值照常通过,大小写不敏感
  assert.deepEqual(parseMintRegion({ region: 'EU' }), { region: 'eu' });
  // 拼错的普通字符串也拦
  assert.equal(parseMintRegion({ region: 'usa' }).error, 'invalid_region');
});
