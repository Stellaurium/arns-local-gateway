import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { decodeStoredContent } from '../src/native/content-encoding.js';
import { retryTransientRead } from '../src/native/retry-read.js';

test('decodes stacked encodings without modifying the permanent object', async () => {
  const original = Buffer.from('compressed content');
  const result = { body: brotliCompressSync(gzipSync(original)), metadata: { headers: { 'content-encoding': 'gzip, br', 'content-digest': 'encoded-digest' } } };
  const decoded = await decodeStoredContent(result, 1024);
  assert.deepEqual(decoded.body, original);
  assert.equal(decoded.metadata.headers['content-digest'], undefined);
  assert.equal(result.metadata.headers['content-encoding'], 'gzip, br');
});

test('rejects oversized decompression and unsupported content encoding', async () => {
  const body = gzipSync(Buffer.alloc(10000));
  await assert.rejects(decodeStoredContent({ body, metadata: { headers: { 'content-encoding': 'gzip' } } }, 100), /larger than|too large/i);
  await assert.rejects(decodeStoredContent({ body, metadata: { headers: { 'content-encoding': 'unknown' } } }, 100), /Unsupported/);
});

test('read retries are bounded and do not retry access denial, absence, rate limits or bad certificates', async () => {
  for (const status of [401,403,404,429]) {
    let calls = 0;
    await assert.rejects(retryTransientRead(async () => { calls++; throw Object.assign(new Error('HTTP'), { status }); }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(retryTransientRead(async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryTransientRead(async () => { calls++; throw new TypeError('fetch failed'); }));
  assert.equal(calls, 2);
});
