import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spApiUserAgent, adsUserAgent } from '../dist/internal/user-agent.js';

test('spApiUserAgent 优先用各主体的 SP_API_USER_AGENT,未配则回退默认', () => {
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

test('两个主体各设不同 UA 就得到不同指纹', () => {
  process.env.SP_API_USER_AGENT = 'AppA/1.0';
  const a = spApiUserAgent();
  process.env.SP_API_USER_AGENT = 'AppB/3.4';
  const b = spApiUserAgent();
  assert.notEqual(a, b);
  delete process.env.SP_API_USER_AGENT;
});
