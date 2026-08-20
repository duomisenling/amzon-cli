// 令牌寿命计算 —— 守住"CLI 永远不会拿到一张已经死了的票"这个不变量。
//
// 背景:Broker 和 CLI 各有一层缓存。Broker 缓存命中时如果回填铸票那一刻的
// expires_in(3600),CLI(broker.ts)会按 expires_in - 60 缓存,于是把一张只剩
// 两分钟的票当成新票留用近一小时;常驻进程(MCP)会连着吃 401,而 CLI 把 401
// 归成 auth_expired 且不重试,报"授权已过期,请重新授权"——完全指错方向。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingSeconds, SERVE_MARGIN_MS } from '../protocol.mjs';

/** CLI 侧的缓存策略(broker.ts:202):按 expires_in - 60 秒缓存。 */
const CLI_MARGIN_S = 60;

test('剩余寿命随时间递减,不是固定的铸票值', () => {
  const t0 = 1_000_000_000_000;
  const realExpiresAt = t0 + 3600_000;

  assert.equal(remainingSeconds(realExpiresAt, t0), 3600);
  assert.equal(remainingSeconds(realExpiresAt, t0 + 1800_000), 1800);
  assert.equal(remainingSeconds(realExpiresAt, t0 + 3400_000), 200);
});

test('不返回 0 或负数', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(remainingSeconds(t0, t0), 1);
  assert.equal(remainingSeconds(t0, t0 + 60_000), 1);
});

test('不变量:发放窗口内的任一时刻,CLI 缓存到期都不晚于票的真实死亡时间', () => {
  const t0 = 1_000_000_000_000;
  const realExpiresAt = t0 + 3600_000;
  const serveUntil = realExpiresAt - SERVE_MARGIN_MS;

  // 覆盖整个发放窗口,每秒取一次
  for (let now = t0; now < serveUntil; now += 1000) {
    const expiresIn = remainingSeconds(realExpiresAt, now);
    const cliCacheExpiresAt = now + (expiresIn - CLI_MARGIN_S) * 1000;
    assert.ok(
      cliCacheExpiresAt <= realExpiresAt,
      `now=${now - t0}ms 时 CLI 会缓存到票死后 ${(cliCacheExpiresAt - realExpiresAt) / 1000}s`,
    );
  }
});

test('回归:回填固定 3600 会违反上面的不变量(证明这个测试抓得住原来的 bug)', () => {
  const t0 = 1_000_000_000_000;
  const realExpiresAt = t0 + 3600_000;
  const now = t0 + 3400_000; // 票只剩 200 秒

  const buggyExpiresIn = 3600; // 旧实现:原样返回铸票时的值
  const cliCacheExpiresAt = now + (buggyExpiresIn - CLI_MARGIN_S) * 1000;
  assert.ok(cliCacheExpiresAt > realExpiresAt, '旧实现本该越界');
  // 越界近一小时 —— 这段时间里所有请求都会 401
  assert.ok((cliCacheExpiresAt - realExpiresAt) / 1000 > 3300);
});
