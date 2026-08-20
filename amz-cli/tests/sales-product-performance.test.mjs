import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildProductPerformanceWindows,
  downloadReportWithRetry,
  parseSalesTrafficByAsin,
  parseSalesTrafficReport,
  resolveProductPerformanceAsOf,
  salesProductPerformance,
  selectProductPerformanceCandidates,
} from '../dist/shortcuts/sales/product-performance.js';

const options = {
  minPriorUnits: 3,
  declinePercentage: 30,
  minSessions: 20,
  buyBoxDropPoints: 20,
  limit: 20,
};

function metrics(asin, overrides = {}) {
  return {
    asin,
    units: 0,
    orders: 0,
    sales: 0,
    sessions: 0,
    unitSessionPercentage: null,
    buyBoxPercentage: null,
    ...overrides,
  };
}

test('comparison windows use complete adjacent UTC days', () => {
  const windows = buildProductPerformanceWindows(30, Date.parse('2026-08-14T12:34:56Z'));
  assert.deepEqual(windows, {
    currentStart: '2026-07-15T00:00:00Z',
    currentEnd: '2026-08-13T23:59:59Z',
    previousStart: '2026-06-15T00:00:00Z',
    previousEnd: '2026-07-14T23:59:59Z',
  });
  assert.deepEqual(buildProductPerformanceWindows(7, '2026-08-13'), {
    currentStart: '2026-08-07T00:00:00Z',
    currentEnd: '2026-08-13T23:59:59Z',
    previousStart: '2026-07-31T00:00:00Z',
    previousEnd: '2026-08-06T23:59:59Z',
  });
});

test('as-of defaults to yesterday UTC and rejects malformed or incomplete dates', () => {
  const now = Date.parse('2026-08-14T00:01:00Z');
  assert.equal(resolveProductPerformanceAsOf(undefined, now), '2026-08-13');
  assert.equal(resolveProductPerformanceAsOf('2026-08-13', now), '2026-08-13');
  assert.throws(
    () => resolveProductPerformanceAsOf('2026-02-30', now),
    (error) => error?.subtype === 'sales.invalid_as_of',
  );
  assert.throws(
    () => resolveProductPerformanceAsOf('2026-08-14', now),
    (error) => error?.subtype === 'sales.invalid_as_of',
  );
});

test('parseSalesTrafficByAsin parses and aggregates child-ASIN sales and traffic', () => {
  const rows = parseSalesTrafficByAsin(
    JSON.stringify({
      salesAndTrafficByAsin: [
        {
          parentAsin: 'B000000000',
          childAsin: 'B000000001',
          salesByAsin: {
            unitsOrdered: 3,
            totalOrderItems: 2,
            orderedProductSales: { amount: 30.25, currencyCode: 'USD' },
          },
          trafficByAsin: { sessions: 20, unitSessionPercentage: 15, buyBoxPercentage: 80 },
        },
        {
          parentAsin: 'B000000000',
          childAsin: 'B000000001',
          salesByAsin: {
            unitsOrdered: 2,
            totalOrderItems: 2,
            orderedProductSales: { amount: 19.75, currencyCode: 'USD' },
          },
          trafficByAsin: { browserSessions: 10, mobileAppSessions: 10, buyBoxPercentage: 40 },
        },
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    asin: 'B000000001',
    parentAsin: 'B000000000',
    units: 5,
    orders: 4,
    sales: 50,
    currency: 'USD',
    sessions: 40,
    unitSessionPercentage: 12.5,
    buyBoxPercentage: 60,
  });
});

test('parseSalesTrafficByAsin tolerates malformed documents and missing rows', () => {
  assert.deepEqual(parseSalesTrafficByAsin(''), []);
  assert.deepEqual(parseSalesTrafficByAsin('not-json'), []);
  assert.deepEqual(parseSalesTrafficByAsin('{}'), []);
  assert.deepEqual(parseSalesTrafficByAsin('{"salesAndTrafficByAsin":"bad"}'), []);
});

test('parent summary rows are excluded only when a distinct child references them', () => {
  const parsed = parseSalesTrafficReport(
    JSON.stringify({
      salesAndTrafficByAsin: [
        {
          parentAsin: 'B0PARENT00',
          salesByAsin: { unitsOrdered: 100 },
          trafficByAsin: { sessions: 1000 },
        },
        {
          parentAsin: 'B0PARENT00',
          childAsin: 'B0CHILD001',
          salesByAsin: { unitsOrdered: 2 },
          trafficByAsin: { sessions: 20 },
        },
        {
          parentAsin: 'B0STANDALN',
          childAsin: 'B0STANDALN',
          salesByAsin: { unitsOrdered: 1 },
          trafficByAsin: { sessions: 10 },
        },
      ],
    }),
  );
  assert.deepEqual(parsed.excludedParents, ['B0PARENT00']);
  assert.deepEqual(parsed.rows.map((row) => row.asin), ['B0CHILD001', 'B0STANDALN']);
});

test('selectProductPerformanceCandidates explains decline, conversion, and Buy Box reasons', () => {
  const previous = [
    metrics('B000000001', {
      units: 10,
      sales: 200,
      sessions: 50,
      unitSessionPercentage: 20,
      buyBoxPercentage: 90,
    }),
  ];
  const current = [
    metrics('B000000001', {
      units: 3,
      sales: 50,
      sessions: 60,
      unitSessionPercentage: 5,
      buyBoxPercentage: 60,
    }),
  ];
  const [candidate] = selectProductPerformanceCandidates(current, previous, options);
  assert.deepEqual(candidate.reasons, [
    'sales-decline',
    'conversion-decline',
    'buybox-decline',
  ]);
  assert.equal(candidate.change.unitsPercentage, -70);
  assert.equal(candidate.change.unitSessionPercentagePoints, -15);
  assert.equal(candidate.change.buyBoxPercentagePoints, -30);
});

test('traffic with zero units is a candidate but a new ASIN with no traffic is not', () => {
  const current = [
    metrics('B000000001', { sessions: 30, unitSessionPercentage: 0 }),
    metrics('B000000002'),
  ];
  const rows = selectProductPerformanceCandidates(current, [], options);
  assert.deepEqual(rows.map((row) => row.asin), ['B000000001']);
  assert.deepEqual(rows[0].reasons, ['traffic-no-conversion']);
});

test('insufficient samples do not trigger changes', () => {
  const previous = [
    metrics('B000000001', { units: 2, sales: 20, sessions: 10, unitSessionPercentage: 20 }),
  ];
  const current = [
    metrics('B000000001', { units: 0, sales: 0, sessions: 10, unitSessionPercentage: 0 }),
  ];
  assert.deepEqual(selectProductPerformanceCandidates(current, previous, options), []);
});

test('candidate limit is enforced after severity sorting', () => {
  const previous = [];
  const current = Array.from({ length: 21 }, (_, index) =>
    metrics(`B${String(index).padStart(9, '0')}`, {
      sessions: 20 + index,
      unitSessionPercentage: 0,
    }),
  );
  const rows = selectProductPerformanceCandidates(current, previous, options);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].asin, 'B000000020');
  assert.equal(rows.at(-1).asin, 'B000000001');
});

test('candidate offset returns the next stable slice after sorting', () => {
  const current = Array.from({ length: 5 }, (_, index) =>
    metrics(`B${String(index).padStart(9, '0')}`, {
      sessions: 20 + index,
      unitSessionPercentage: 0,
    }),
  );
  const rows = selectProductPerformanceCandidates(current, [], {
    ...options,
    limit: 2,
    offset: 2,
  });
  assert.deepEqual(rows.map((row) => row.asin), ['B000000002', 'B000000001']);
});

test('generated report download retries without creating another report', async () => {
  const progress = [];
  let attempts = 0;
  const ctx = { progress(message) { progress.push(message); } };
  const text = await downloadReportWithRetry(
    ctx,
    'REPORT-1',
    'DOCUMENT-1',
    'na',
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient fetch failure');
      return '{"ok":true}';
    },
    async () => {},
  );
  assert.equal(text, '{"ok":true}');
  assert.equal(attempts, 3);
  assert.equal(progress.length, 2);
});

test('generated report download surfaces a resumable typed error after three failures', async () => {
  let attempts = 0;
  await assert.rejects(
    () => downloadReportWithRetry(
      { progress() {} },
      'REPORT-2',
      'DOCUMENT-2',
      'na',
      async () => {
        attempts += 1;
        throw new Error('still unavailable');
      },
      async () => {},
    ),
    (error) => error?.subtype === 'report.download_resume_required' && error?.retryable === true,
  );
  assert.equal(attempts, 3);
});

test('command is read-only and declares the report role', () => {
  assert.equal(salesProductPerformance.service, 'sales');
  assert.equal(salesProductPerformance.command, 'product-performance');
  assert.equal(salesProductPerformance.mutation, 'none');
  assert.deepEqual(salesProductPerformance.roles, ['Selling Partner Insights']);
});
