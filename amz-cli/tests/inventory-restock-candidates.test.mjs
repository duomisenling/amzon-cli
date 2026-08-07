import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  selectRestockCandidates,
  parseUnitsByAsin,
  restockCandidates,
} from '../dist/shortcuts/inventory/restock-candidates.js';

const inventory = [
  // 断货 + 好卖 → 应入选,排最前(销量最高)
  { sku: 'HOT-OOS', asin: 'B0HOT', name: '爆款拖鞋', fulfillable: 0, inbound: 0 },
  // 断货 + 好卖(销量较低)→ 入选,排后
  { sku: 'WARM-OOS', asin: 'B0WARM', name: '次爆款', fulfillable: 0, inbound: 0 },
  // 断货但没销量 → 不入选(不是"以前好卖")
  { sku: 'DEAD-OOS', asin: 'B0DEAD', name: '滞销断货', fulfillable: 0, inbound: 0 },
  // 好卖但有货 → 不入选(不缺货)
  { sku: 'HOT-INSTOCK', asin: 'B0HOT2', name: '爆款有货', fulfillable: 50, inbound: 0 },
  // 好卖、可售为 0 但在途一堆 → 不入选(在途已覆盖,available>0)
  { sku: 'HOT-INBOUND', asin: 'B0HOT3', name: '补货在途', fulfillable: 0, inbound: 100 },
];

const unitsByAsin = {
  B0HOT: 120,
  B0WARM: 8,
  B0HOT2: 200,
  B0HOT3: 90,
  // B0DEAD 无销量
};

test('selectRestockCandidates 只留"断货且以前好卖",按销量降序', () => {
  const out = selectRestockCandidates(inventory, unitsByAsin, {
    stockThreshold: 0,
    minUnits: 1,
  });
  assert.deepEqual(
    out.map((c) => c.sku),
    ['HOT-OOS', 'WARM-OOS'],
  );
  assert.equal(out[0].unitsSold, 120);
  assert.equal(out[0].available, 0);
  assert.equal(out[1].unitsSold, 8);
});

test('stockThreshold 放宽可纳入低库存与在途覆盖的品', () => {
  const out = selectRestockCandidates(inventory, unitsByAsin, {
    stockThreshold: 100,
    minUnits: 1,
  });
  // available <= 100:HOT-OOS(0)、WARM-OOS(0)、HOT-INSTOCK(50)、HOT-INBOUND(100) 入选;
  // 按销量降序:HOT-INSTOCK(200) > HOT-OOS(120) > HOT-INBOUND(90) > WARM-OOS(8)
  assert.deepEqual(
    out.map((c) => c.sku),
    ['HOT-INSTOCK', 'HOT-OOS', 'HOT-INBOUND', 'WARM-OOS'],
  );
});

test('minUnits 抬高可过滤掉销量不足的品', () => {
  const out = selectRestockCandidates(inventory, unitsByAsin, {
    stockThreshold: 0,
    minUnits: 10,
  });
  assert.deepEqual(
    out.map((c) => c.sku),
    ['HOT-OOS'],
  );
});

test('limit 截断返回条数', () => {
  const out = selectRestockCandidates(inventory, unitsByAsin, {
    stockThreshold: 100,
    minUnits: 1,
    limit: 2,
  });
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.sku),
    ['HOT-INSTOCK', 'HOT-OOS'],
  );
});

test('无 asin 的库存项按 0 销量处理,不误入选', () => {
  const out = selectRestockCandidates(
    [{ sku: 'NO-ASIN', fulfillable: 0, inbound: 0 }],
    unitsByAsin,
    { stockThreshold: 0, minUnits: 1 },
  );
  assert.deepEqual(out, []);
});

test('parseUnitsByAsin 从 Sales & Traffic 报告抽取子 ASIN 销量', () => {
  const report = JSON.stringify({
    salesAndTrafficByAsin: [
      { parentAsin: 'B0P1', childAsin: 'B0HOT', salesByAsin: { unitsOrdered: 120 } },
      { parentAsin: 'B0P1', childAsin: 'B0WARM', salesByAsin: { unitsOrdered: 8 } },
      { parentAsin: 'B0P2', childAsin: 'B0DEAD', salesByAsin: { unitsOrdered: 0 } },
    ],
  });
  assert.deepEqual(parseUnitsByAsin(report), { B0HOT: 120, B0WARM: 8, B0DEAD: 0 });
});

test('parseUnitsByAsin 对同一 ASIN 多行累加', () => {
  const report = JSON.stringify({
    salesAndTrafficByAsin: [
      { childAsin: 'B0X', salesByAsin: { unitsOrdered: 3 } },
      { childAsin: 'B0X', salesByAsin: { unitsOrdered: 5 } },
    ],
  });
  assert.deepEqual(parseUnitsByAsin(report), { B0X: 8 });
});

test('parseUnitsByAsin 容错空/坏输入', () => {
  assert.deepEqual(parseUnitsByAsin(''), {});
  assert.deepEqual(parseUnitsByAsin('not json'), {});
  assert.deepEqual(parseUnitsByAsin('{}'), {});
  assert.deepEqual(parseUnitsByAsin(JSON.stringify({ salesAndTrafficByAsin: 'x' })), {});
});

test('库存翻页超过 100 页熔断,抛类型化上游错误(防 nextToken 异常无限翻页)', async () => {
  const ctx = {
    flags: { marketplace: 'US' },
    progress() {},
    client: {
      // 永远返回 nextToken,模拟上游分页异常
      async get() {
        return {
          payload: { inventorySummaries: [] },
          pagination: { nextToken: 'ALWAYS-MORE' },
        };
      },
    },
  };
  await assert.rejects(
    () => restockCandidates.execute(ctx),
    (e) => e?.subtype === 'inventory.pagination_overflow' && e?.type === 'upstream_error',
  );
});
