import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseBody } from '../lib/http.js';

test('JSON bodies over the configured limit are rejected', async () => {
  const req = Readable.from([Buffer.from('{"hello":"world"}')]);
  await assert.rejects(parseBody(req, 8), error => error.status === 413);
});

test('malformed JSON is reported as a client error', async () => {
  const req = Readable.from([Buffer.from('{"hello":')]);
  await assert.rejects(parseBody(req), error => error.status === 400);
});
