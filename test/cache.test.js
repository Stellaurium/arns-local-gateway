import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheTtlFromHeaders, DiskCache } from '../src/cache.js';

test('stores and reads a response from disk', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arns-gateway-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cache = new DiskCache(directory, 60);
  await cache.put('key', {
    statusCode: 200,
    headers: { 'content-type': 'text/plain' },
    sourceGateway: 'example.test',
    ttlSeconds: 60,
    body: Buffer.from('hello')
  });
  const result = await cache.get('key');
  assert.equal(result.body.toString(), 'hello');
  assert.equal(result.fresh, true);
  assert.equal(result.sourceGateway, 'example.test');
});

test('caps upstream cache-control at the configured TTL', () => {
  assert.equal(cacheTtlFromHeaders({ 'cache-control': 'public, max-age=3600' }, 900), 900);
  assert.equal(cacheTtlFromHeaders({ 'cache-control': 'max-age=30' }, 900), 30);
  assert.equal(cacheTtlFromHeaders({}, 900), 900);
});
