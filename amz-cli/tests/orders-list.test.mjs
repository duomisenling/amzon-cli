import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordersList } from '../dist/shortcuts/orders/list.js';

test('orders list:--created-after 与 --updated-after 同给时显式报互斥错误,不再静默取其一', () => {
  assert.throws(
    () =>
      ordersList.validate({
        marketplace: 'US',
        createdAfter: '2026-07-01T00:00:00Z',
        updatedAfter: '2026-07-02T00:00:00Z',
      }),
    (e) => e?.subtype === 'conflicting_time_filter' && e?.type === 'invalid_param',
  );
});

test('orders list:--created-after 非法 ISO 8601 报错', () => {
  assert.throws(
    () => ordersList.validate({ marketplace: 'US', createdAfter: 'last week' }),
    (e) => e?.subtype === 'invalid_created_after',
  );
  assert.throws(
    () => ordersList.validate({ marketplace: 'US', createdAfter: '2026-13-01T00:00:00Z' }), // 13 月
    (e) => e?.subtype === 'invalid_created_after',
  );
});

test('orders list:--updated-after 非法 ISO 8601 报错', () => {
  assert.throws(
    () => ordersList.validate({ marketplace: 'US', updatedAfter: '07/01/2026' }),
    (e) => e?.subtype === 'invalid_updated_after',
  );
});

test('orders list:合法参数通过校验(单给其一 + 合法 ISO)', () => {
  ordersList.validate({ marketplace: 'US', createdAfter: '2026-07-01T00:00:00Z' });
  ordersList.validate({ marketplace: 'US', updatedAfter: '2026-07-01T00:00:00+08:00' });
  ordersList.validate({ marketplace: 'US' }); // 两个都不给,走默认 --days
});
