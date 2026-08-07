import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { SpApiClient } from '../dist/internal/client/client.js';
import { AdsClient } from '../dist/internal/client/ads-client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of [
    'BROKER_URL',
    'TEAM_TOKEN',
    'STORE',
    'LWA_CLIENT_ID',
    'LWA_CLIENT_SECRET',
    'LWA_REFRESH_TOKEN',
    'ADS_CLIENT_ID',
    'ADS_CLIENT_SECRET',
    'ADS_REFRESH_TOKEN',
  ]) {
    delete process.env[key];
  }
});

const credentials = {
  async getCredentials() {
    return {
      accessToken: 'short-lived-token',
      endpoint: 'https://sellingpartnerapi-na.amazon.com',
      region: 'na',
    };
  },
};

test('Ads local auth never falls back to SP-API LWA credentials', async () => {
  process.env.LWA_CLIENT_ID = 'sp-client';
  process.env.LWA_CLIENT_SECRET = 'sp-secret';
  process.env.LWA_REFRESH_TOKEN = 'sp-refresh-token';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('fetch must not be called without explicit ADS_* credentials');
  };

  const client = new AdsClient();
  await assert.rejects(
    () => client.request('GET', '/v2/profiles'),
    (error) => error?.subtype === 'ads.credentials_missing',
  );
  assert.equal(calls, 0);
});

test('non-idempotent POST is not replayed after an ambiguous 5xx', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [{ message: 'temporary gateway failure' }] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('POST', '/feeds/2021-06-30/feeds', { body: { feedType: 'x' } }),
    (error) => error?.subtype === 'sp_api.write_result_unknown' && error?.hintAgent === 'report_to_human',
  );
  assert.equal(calls, 1);
});

test('SP write network failure is reported as unknown and never marked retryable', async () => {
  globalThis.fetch = async () => {
    throw new DOMException('request timed out', 'AbortError');
  };
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('PATCH', '/listings/2021-08-01/items/seller/sku', { body: {} }),
    (error) =>
      error?.subtype === 'sp_api.write_result_unknown' &&
      error?.hintAgent === 'report_to_human' &&
      error?.retryable === false,
  );
});

test('SP write with an invalid successful response is not presented as retryable', async () => {
  globalThis.fetch = async () => new Response('<bad gateway html>', { status: 200 });
  const client = new SpApiClient(credentials);

  await assert.rejects(
    () => client.request('POST', '/feeds/2021-06-30/feeds', { body: {} }),
    (error) => error?.subtype === 'sp_api.write_result_unknown' && error?.retryable === false,
  );
});

test('Ads write network failure is reported as unknown and never marked retryable', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  process.env.TEAM_TOKEN = 'team-token';
  process.env.STORE = 'SHOP';
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    if (new URL(input).hostname === 'broker.example.test') {
      return new Response(
        JSON.stringify({
          access_token: 'short-lived-token',
          expires_in: 3600,
          endpoint: 'https://advertising-api.amazon.com',
          client_id: 'public-client-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new DOMException('request timed out', 'AbortError');
  };

  const client = new AdsClient();
  await assert.rejects(
    () => client.request('PUT', '/sp/campaigns', { profileId: '123', body: {} }),
    (error) =>
      error?.subtype === 'ads.write_result_unknown' &&
      error?.hintAgent === 'report_to_human' &&
      error?.retryable === false,
  );
  assert.equal(calls, 2);
});

test('Ads write with an invalid successful response is not presented as retryable', async () => {
  process.env.BROKER_URL = 'https://broker.example.test';
  process.env.TEAM_TOKEN = 'team-token';
  process.env.STORE = 'SHOP';
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === 'broker.example.test') {
      return new Response(
        JSON.stringify({
          access_token: 'short-lived-token',
          expires_in: 3600,
          endpoint: 'https://advertising-api.amazon.com',
          client_id: 'public-client-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('<bad gateway html>', { status: 200 });
  };

  const client = new AdsClient();
  await assert.rejects(
    () => client.request('POST', '/sp/negativeKeywords', { profileId: '123', body: {} }),
    (error) => error?.subtype === 'ads.write_result_unknown' && error?.retryable === false,
  );
});

test('代理配置错误的写请求报 invalid_param,而不是"写结果未知"', async () => {
  // 代理 URL 非法时 egress 在发出任何字节之前就抛错 —— 此时不存在歧义,
  // 包装成 write_result_unknown 会误导用户去 Seller Central 核对一次没发出的写入。
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };
  process.env.SP_API_PROXY = '这不是一个地址';
  try {
    const client = new SpApiClient(credentials);
    await assert.rejects(
      () => client.request('POST', '/feeds/2021-06-30/feeds', { body: { feedType: 'x' } }),
      (error) =>
        error?.subtype === 'egress.invalid_proxy_url' &&
        error?.type === 'invalid_param' &&
        error?.subtype !== 'sp_api.write_result_unknown',
    );
    assert.equal(calls, 0, '代理配置错误竟然还发出了请求');
  } finally {
    delete process.env.SP_API_PROXY;
  }
});

test('广告写请求遇到代理配置错误同样报 invalid_param', async () => {
  process.env.ADS_CLIENT_ID = 'ads-client';
  process.env.ADS_CLIENT_SECRET = 'ads-secret';
  process.env.ADS_REFRESH_TOKEN = 'ads-refresh';
  process.env.ADS_PROXY = 'socks5://127.0.0.1:1080';
  try {
    const client = new AdsClient();
    await assert.rejects(
      () => client.request('POST', '/sp/campaigns', { body: { campaigns: [] } }),
      (error) => error?.subtype === 'egress.unsupported_proxy_scheme' && error?.type === 'invalid_param',
    );
  } finally {
    delete process.env.ADS_PROXY;
  }
});

// —— 2xx 后读响应体失败:写请求"结果未知",读请求可重试 ——

/** 一个 2xx 响应,但读 body 时连接中断(模拟状态行到了、内容没到齐)。 */
function okResponseWithBrokenBody(status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers(),
    text: async () => {
      throw new DOMException('body read timed out', 'AbortError');
    },
  };
}

/** 用假 ADS_* 凭证 + 假 LWA 令牌响应,把 AdsClient 引到业务请求那一步。 */
function useFakeAdsCreds() {
  process.env.ADS_CLIENT_ID = 'ads-client';
  process.env.ADS_CLIENT_SECRET = 'ads-secret';
  process.env.ADS_REFRESH_TOKEN = 'ads-refresh';
}

function lwaTokenResponse() {
  return new Response(
    JSON.stringify({ access_token: 'short-lived-token', expires_in: 3600, token_type: 'bearer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

test('SP 写请求 2xx 后读响应体失败报"写结果未知",审计不记成功', async () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'amz-audit-body-'));
  process.env.AMZ_AUDIT_DIR = auditDir;
  globalThis.fetch = async () => okResponseWithBrokenBody();
  try {
    const client = new SpApiClient(credentials);
    await assert.rejects(
      () => client.request('POST', '/feeds/2021-06-30/feeds', { body: { feedType: 'x' } }),
      (error) =>
        error?.subtype === 'sp_api.write_result_unknown' &&
        error?.hintAgent === 'report_to_human' &&
        error?.retryable === false &&
        error?.cause !== undefined,
    );
    // 审计矛盾防护:HTTP 200 但 body 没读成,不能留下 ok:true 的成功底账
    const month = new Date().toISOString().slice(0, 7);
    const lines = readFileSync(join(auditDir, 'default', `${month}.log`), 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1));
    assert.equal(last.ok, false);
    assert.equal(last.error, 'sp_api.write_result_unknown');
  } finally {
    delete process.env.AMZ_AUDIT_DIR;
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('SP 读请求 2xx 后读响应体失败归为可重试网络错误', async () => {
  globalThis.fetch = async () => okResponseWithBrokenBody();
  const client = new SpApiClient(credentials);
  await assert.rejects(
    () => client.get('/orders/v0/orders'),
    (error) => error?.subtype === 'sp_api.network_error' && error?.retryable === true,
  );
});

test('广告写请求 2xx 后读响应体失败报"写结果未知"', async () => {
  useFakeAdsCreds();
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === 'api.amazon.com') return lwaTokenResponse();
    return okResponseWithBrokenBody();
  };
  const client = new AdsClient();
  await assert.rejects(
    () => client.request('POST', '/sp/campaigns', { profileId: '123', body: {} }),
    (error) =>
      error?.subtype === 'ads.write_result_unknown' &&
      error?.hintAgent === 'report_to_human' &&
      error?.retryable === false,
  );
});

test('广告读请求 2xx 后读响应体失败归为可重试网络错误', async () => {
  useFakeAdsCreds();
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === 'api.amazon.com') return lwaTokenResponse();
    return okResponseWithBrokenBody();
  };
  const client = new AdsClient();
  await assert.rejects(
    () => client.request('GET', '/v2/profiles'),
    (error) => error?.subtype === 'ads.network_error' && error?.retryable === true,
  );
});

test('retry-after 响应头超过 60 秒会被 cap,不会照单静默睡满', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } });
    }
    return new Response('{"payload":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new SpApiClient(credentials);
  let done = false;
  const pending = client.get('/orders/v0/orders').finally(() => {
    done = true;
  });
  // 每轮先用 setImmediate(未被 mock)放行微任务/IO,再步进假时钟 2s。
  // 推满 120s 足够覆盖 cap 后的 60s + 限流间隔;若 cap 失效(要睡 3600s),
  // 120s 假时钟内醒不过来,断言失败。
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2000);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, true, 'retry-after=3600 没有被 cap 到 60 秒');
  assert.deepEqual(await pending, { payload: [] });
  assert.equal(calls, 2);
});

test('广告 401 归类为授权过期(reauthorize),403 保持权限不足', async () => {
  useFakeAdsCreds();
  let status = 401;
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === 'api.amazon.com') return lwaTokenResponse();
    return new Response('{"message":"denied"}', { status });
  };
  const client = new AdsClient();
  await assert.rejects(
    () => client.request('GET', '/v2/profiles'),
    (error) =>
      error?.type === 'auth_expired' &&
      error?.subtype === 'ads.unauthorized' &&
      error?.hintAgent === 'reauthorize',
  );
  status = 403;
  await assert.rejects(
    () => client.request('GET', '/v2/profiles'),
    (error) =>
      error?.type === 'insufficient_scope' &&
      error?.subtype === 'ads.access_denied' &&
      error?.hintAgent === 'report_to_human',
  );
});

test('广告 LWA 换令牌失败的报错信息会截断超长响应体', async () => {
  useFakeAdsCreds();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'x'.repeat(50_000) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  const client = new AdsClient();
  await assert.rejects(
    () => client.request('GET', '/v2/profiles'),
    (error) => error?.subtype === 'ads.token_exchange_failed' && error.message.length < 2200,
  );
});
