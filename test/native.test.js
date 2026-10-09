import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractDataItem } from '../src/native/bundle-peer-source.js';
import { ImmutableContentStore } from '../src/native/content-store.js';
import { manifestDataIds, parseManifest, resolveManifestPath } from '../src/native/manifest.js';

function avroLong(value) {
  let remaining = BigInt(value) << 1n;
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function avroString(value) {
  const body = Buffer.from(value);
  return Buffer.concat([avroLong(body.length), body]);
}

function makeDataItem(body, tags) {
  const signature = Buffer.alloc(64, 0x2a);
  const owner = Buffer.alloc(32, 0x17);
  const encodedTags = Buffer.concat([
    avroLong(tags.length),
    ...tags.flatMap((tag) => [avroString(tag.name), avroString(tag.value)]),
    avroLong(0)
  ]);
  const counts = Buffer.alloc(16);
  counts.writeBigUInt64LE(BigInt(tags.length), 0);
  counts.writeBigUInt64LE(BigInt(encodedTags.length), 8);
  const item = Buffer.concat([
    Buffer.from([4, 0]), signature, owner, Buffer.from([0, 0]), counts, encodedTags, body
  ]);
  return { item, id: crypto.createHash('sha256').update(signature).digest('base64url') };
}

test('extracts one ANS-104 data item and checks its ID', () => {
  const expectedBody = Buffer.from('native bundle data');
  const { item, id } = makeDataItem(expectedBody, [{ name: 'Content-Type', value: 'text/plain' }]);
  const parsed = extractDataItem(item, id);
  assert.equal(parsed.body.toString(), expectedBody.toString());
  assert.deepEqual(parsed.tags, [{ name: 'Content-Type', value: 'text/plain' }]);
  assert.throws(() => extractDataItem(item, 'A'.repeat(43)), /ID mismatch/);
});

test('routes an Arweave path manifest', () => {
  const indexId = 'A'.repeat(43);
  const assetId = 'B'.repeat(43);
  const body = Buffer.from(JSON.stringify({
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: 'index.html' },
    paths: { 'index.html': { id: indexId }, 'assets/app.js': { id: assetId } },
    fallback: { id: indexId }
  }));
  const manifest = parseManifest(body, 'application/x.arweave-manifest+json');
  assert.deepEqual(resolveManifestPath(manifest, '/'), { id: indexId, path: 'index.html', resolutionType: 'path' });
  assert.deepEqual(resolveManifestPath(manifest, '/assets/app.js'), { id: assetId, path: 'assets/app.js', resolutionType: 'path' });
  assert.deepEqual(manifestDataIds(manifest).sort(), [indexId, assetId].sort());
});

test('stores direct bundle results permanently and does not retrieve them twice', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-arns-store-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = 'C'.repeat(43);
  let calls = 0;
  const bundleSource = {
    async get(requestedId) {
      calls += 1;
      return {
        body: Buffer.from('permanent'),
        metadata: { id: requestedId, headers: { 'content-type': 'text/plain' } },
        source: 'arweave-peer-chunks'
      };
    }
  };
  const store = new ImmutableContentStore({
    directory,
    providerUrls: [],
    timeoutMs: 100,
    maxResponseBytes: 1024,
    bundleSource,
    logger: { info() {} }
  });
  const first = await store.get(id);
  const second = await store.get(id);
  assert.equal(first.source, 'arweave-peer-chunks');
  assert.equal(second.source, 'immutable-store');
  assert.equal(second.body.toString(), 'permanent');
  assert.equal(calls, 1);
});

test('coalesces concurrent downloads of one immutable ID', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-arns-concurrent-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const id = 'D'.repeat(43);
  const store = new ImmutableContentStore({ directory, providerUrls: [], timeoutMs: 100, maxResponseBytes: 1024,
    logger: { info() {} }, bundleSource: { async get() {
      calls++; await new Promise(resolve => setTimeout(resolve, 10));
      return { body: Buffer.from('shared'), metadata: { id, headers: {} }, source: 'arweave-peer-chunks' };
    } } });
  const result = await Promise.all(Array.from({ length: 12 }, () => store.get(id)));
  assert.equal(calls, 1);
  assert.equal(result.length, 12);
  assert.equal((await store.get(id)).source, 'immutable-store');
});

test('retries a transient provider connection failure once, without caching failure', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-arns-retry-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = 'E'.repeat(43); let calls = 0;
  const store = new ImmutableContentStore({ directory, providerUrls: ['https://provider.example/raw/{id}'], timeoutMs: 100, maxResponseBytes: 1024, logger: { info() {} } });
  store.fetchProvider = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return { body: Buffer.from('retried'), metadata: { id, headers: {} }, source: 'data-provider' };
  };
  assert.equal((await store.get(id)).body.toString(), 'retried');
  assert.equal(calls, 2);
  assert.equal((await store.get(id)).source, 'immutable-store');
});
