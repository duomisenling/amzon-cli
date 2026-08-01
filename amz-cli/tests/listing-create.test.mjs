import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAttributes,
  assertValidationPassed,
  assertSubmissionAccepted,
} from '../dist/shortcuts/listing/create.js';

test('parseAttributes 接受非空对象(内联 JSON)', () => {
  const attrs = parseAttributes({ attributes: '{"item_name":[{"value":"x"}]}' });
  assert.deepEqual(attrs, { item_name: [{ value: 'x' }] });
});

test('parseAttributes 拒绝缺失/坏 JSON/非对象/空对象', () => {
  assert.throws(() => parseAttributes({}), /required/);
  assert.throws(() => parseAttributes({ attributes: '{bad' }), /not valid JSON/);
  assert.throws(() => parseAttributes({ attributes: '[]' }), /non-empty JSON object/);
  assert.throws(() => parseAttributes({ attributes: '{}' }), /non-empty JSON object/);
});

test('assertValidationPassed:VALID 且无 ERROR 通过', () => {
  assert.doesNotThrow(() => assertValidationPassed({ status: 'VALID', issues: [] }));
  assert.doesNotThrow(() =>
    assertValidationPassed({ status: 'VALID', issues: [{ severity: 'WARNING', message: 'w' }] }),
  );
});

test('assertValidationPassed:INVALID 或有 ERROR 抛错', () => {
  assert.throws(() => assertValidationPassed({ status: 'INVALID', issues: [] }), /validation preview failed/);
  assert.throws(
    () => assertValidationPassed({ status: 'VALID', issues: [{ severity: 'ERROR', message: 'missing brand' }] }),
    /validation preview failed/,
  );
});

test('assertSubmissionAccepted:ACCEPTED 通过,INVALID/其他抛错', () => {
  assert.doesNotThrow(() => assertSubmissionAccepted({ status: 'ACCEPTED' }));
  assert.throws(() => assertSubmissionAccepted({ status: 'INVALID' }), /submission rejected/);
  assert.throws(() => assertSubmissionAccepted({ status: 'WEIRD' }), /unexpected listing create submission/);
});
