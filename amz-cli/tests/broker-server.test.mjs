import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  MAX_REQUEST_BODY_BYTES,
  parseMintApi,
  readRequestBody,
} from '../../amz-broker/protocol.mjs';

test('Broker rejects unknown api values instead of silently selecting SP-API', () => {
  assert.equal(parseMintApi('sp-api'), 'sp-api');
  assert.equal(parseMintApi('ads'), 'ads');
  assert.equal(parseMintApi('ad'), null);
  assert.equal(parseMintApi(undefined), null);
});

test('Broker request body reader enforces its size limit', async () => {
  await assert.rejects(
    () => readRequestBody(Readable.from([Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1)])),
    (error) => error?.code === 'BODY_TOO_LARGE',
  );
  assert.equal(await readRequestBody(Readable.from(['{"api":"sp-api"}'])), '{"api":"sp-api"}');
});
