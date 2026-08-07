import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spApiUserAgent, adsUserAgent } from '../dist/internal/user-agent.js';

test('spApiUserAgent 优先用该账号的 SP_API_USER_AGENT,未配则回退默认', () => {
  process.env.SP_API_USER_AGENT = 'EntityAApp/1.2.0 (Language=Node.js)';
  assert.equal(spApiUserAgent(), 'EntityAApp/1.2.0 (Language=Node.js)');
  delete process.env.SP_API_USER_AGENT;
  assert.match(spApiUserAgent(), /amz-cli/);
});

test('adsUserAgent 优先 ADS_USER_AGENT,其次复用 SP_API_USER_AGENT', () => {
  delete process.env.ADS_USER_AGENT;
  process.env.SP_API_USER_AGENT = 'SharedApp/2.0';
  assert.equal(adsUserAgent(), 'SharedApp/2.0');
  process.env.ADS_USER_AGENT = 'AdsApp/9.9';
  assert.equal(adsUserAgent(), 'AdsApp/9.9');
  delete process.env.ADS_USER_AGENT;
  delete process.env.SP_API_USER_AGENT;
});

test('ADS_USER_AGENT 留空(空串/空白)时回退到 SP_API_USER_AGENT,而不是直接用默认', () => {
  // 模板承诺"ADS_USER_AGENT 留空则复用 SP 的";空串曾把 ?? 短路,导致回退失效
  process.env.SP_API_USER_AGENT = 'SharedApp/2.0';
  process.env.ADS_USER_AGENT = '';
  assert.equal(adsUserAgent(), 'SharedApp/2.0');
  process.env.ADS_USER_AGENT = '   ';
  assert.equal(adsUserAgent(), 'SharedApp/2.0');
  // 两个都留空才落到通用默认
  process.env.SP_API_USER_AGENT = '  ';
  assert.match(adsUserAgent(), /amz-cli/);
  delete process.env.ADS_USER_AGENT;
  delete process.env.SP_API_USER_AGENT;
});

test('两个账号各设不同 UA 就得到不同取值', () => {
  process.env.SP_API_USER_AGENT = 'AppA/1.0';
  const a = spApiUserAgent();
  process.env.SP_API_USER_AGENT = 'AppB/3.4';
  const b = spApiUserAgent();
  assert.notEqual(a, b);
  delete process.env.SP_API_USER_AGENT;
});
