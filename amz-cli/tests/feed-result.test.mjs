import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateFeedResult, FEED_RESULT_STDOUT_LIMIT } from '../dist/shortcuts/feed/commands.js';

test('truncateFeedResult:不超限时原样返回,不带 truncated 标记', () => {
  const out = truncateFeedResult('short result');
  assert.deepEqual(out, { result: 'short result' });
});

test('truncateFeedResult:超限时截断并显式带 truncated:true 与 --out 提示(不再静默 slice)', () => {
  const text = 'x'.repeat(25);
  const out = truncateFeedResult(text, 10);
  assert.equal(out.result.length, 10);
  assert.equal(out.truncated, true);
  assert.match(out.truncatedNote, /--out/);
  assert.match(out.truncatedNote, /25/); // 提示里带原始长度
});

test('truncateFeedResult:恰好等于上限不算截断', () => {
  const text = 'y'.repeat(10);
  const out = truncateFeedResult(text, 10);
  assert.deepEqual(out, { result: text });
});

test('FEED_RESULT_STDOUT_LIMIT 默认 5 万字符', () => {
  assert.equal(FEED_RESULT_STDOUT_LIMIT, 50_000);
});
