import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundlePeerSource } from '../src/native/bundle-peer-source.js';
import { ArweavePeerPool } from '../src/native/peer-pool.js';

test('a fast peer result is returned without waiting for an unrelated slow peer', async () => {
  const source = new BundlePeerSource({ indexUrls: [], peers: [], timeoutMs: 100, maxResponseBytes: 1024 });
  let slowFinished = false;
  const result = await source.tryPeerBatches(['fast', 'slow'], async peer => {
    if (peer === 'slow') { await new Promise(resolve => setTimeout(resolve, 100)); slowFinished = true; throw new Error('slow failure'); }
    return 'chunk';
  });
  assert.equal(result.value, 'chunk');
  assert.equal(slowFinished, false, 'cold large files must not pay the slowest peer timeout for every chunk');
});

test('retries a transient GraphQL connection reset before abandoning an available index', async () => {
  let calls = 0;
  const source = new BundlePeerSource({ indexUrls: ['https://index.example/graphql'], timeoutMs: 100, maxResponseBytes: 1024,
    fetchImpl: async () => { calls++; if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse({ data: { transactions: { edges: [{ node: { bundledIn: { id: 'B'.repeat(43) }, data: { size: '100', type: 'text/html' } } }] } } });
    } });
  assert.equal((await source.findParent('A'.repeat(43))).parentId, 'B'.repeat(43));
  assert.equal(calls, 2);
});

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

function makeDataItem(body, tags = [{ name: 'Content-Type', value: 'text/plain' }]) {
  const signature = Buffer.alloc(64, 0x41);
  const owner = Buffer.alloc(32, 0x42);
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

function makeBundle(item, id) {
  const header = Buffer.alloc(96);
  header.writeBigUInt64LE(1n, 0);
  header.writeBigUInt64LE(BigInt(item.length), 32);
  Buffer.from(id, 'base64url').copy(header, 64);
  return Buffer.concat([header, item]);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('combines an offset from one peer with chunks from another peer', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-source-cross-node-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { item, id } = makeDataItem(Buffer.from('cross-peer-success'));
  const bundle = makeBundle(item, id);
  const end = 500_000n;
  const start = end - BigInt(bundle.length) + 1n;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://index.example/graphql') {
      return jsonResponse({ data: { transactions: { edges: [{ node: {
        id,
        bundledIn: { id: 'P'.repeat(43) },
        data: { size: String(Buffer.from('cross-peer-success').length), type: null }
      } }] } } });
    }
    if (url === `http://offset-peer.example:1984/tx/${'P'.repeat(43)}/offset`) {
      return jsonResponse({ size: String(bundle.length), offset: String(end) });
    }
    if (url === 'http://offset-peer.example:1984/peers') return jsonResponse(['93.184.216.34:1984']);
    if (url.startsWith('http://93.184.216.34:1984/chunk/')) {
      return jsonResponse({ chunk: bundle.toString('base64url'), absolute_end_offset: String(end) });
    }
    return new Response('', { status: 404 });
  };
  const pool = new ArweavePeerPool({
    seeds: ['http://offset-peer.example:1984'],
    directory,
    timeoutMs: 100,
    fetchImpl,
    discoveryEnabled: true,
    maxDepth: 2
  });
  const source = new BundlePeerSource({
    indexUrls: ['https://index.example/graphql'],
    peerPool: pool,
    timeoutMs: 100,
    maxResponseBytes: 1024 * 1024,
    fetchImpl
  });

  const result = await source.get(id);

  assert.equal(result.body.toString(), 'cross-peer-success');
  assert.equal(result.source, 'arweave-peer-chunks');
  assert.ok(calls.includes(`http://offset-peer.example:1984/tx/${'P'.repeat(43)}/offset`));
  assert.ok(calls.includes('http://offset-peer.example:1984/peers'));
  assert.ok(calls.includes(`http://93.184.216.34:1984/chunk/${start}`));
});

test('discovers peers with BFS and persists them in the local data directory', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-pool-persist-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fetchImpl = async (url) => {
    if (url === 'http://seed.example:1984/peers') {
      return jsonResponse(['93.184.216.34:1984', '127.0.0.1:1984']);
    }
    if (url === 'http://93.184.216.34:1984/peers') return jsonResponse([]);
    return new Response('', { status: 404 });
  };
  const first = new ArweavePeerPool({
    seeds: ['http://seed.example:1984'],
    directory,
    timeoutMs: 100,
    fetchImpl,
    maxPeers: 20,
    maxDepth: 2
  });

  await first.discover(['http://seed.example:1984']);
  assert.ok((await first.candidates()).includes('http://93.184.216.34:1984'));
  assert.ok(!(await first.candidates()).some((peer) => peer.includes('127.0.0.1')));

  const second = new ArweavePeerPool({
    seeds: ['http://seed.example:1984'],
    directory,
    timeoutMs: 100,
    fetchImpl,
    maxPeers: 20,
    maxDepth: 2
  });
  assert.ok((await second.candidates()).includes('http://93.184.216.34:1984'));
});

test('periodic snapshot refresh starts from the old pool and prunes unmentioned dead peers', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-pool-refresh-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  let generation = 1;
  const fetchImpl = async (url) => {
    if (url === 'http://seed.example:1984/peers') {
      return jsonResponse(generation === 1 ? ['93.184.216.34:1984'] : ['8.8.8.8:1984']);
    }
    if (url === 'http://93.184.216.34:1984/peers') {
      return generation === 1 ? jsonResponse([]) : new Response('', { status: 404 });
    }
    if (url === 'http://8.8.8.8:1984/peers') return jsonResponse([]);
    return new Response('', { status: 404 });
  };
  const pool = new ArweavePeerPool({
    seeds: ['http://seed.example:1984'],
    directory,
    timeoutMs: 100,
    fetchImpl,
    maxPeers: 20,
    maxDepth: 2
  });
  await pool.refresh();
  assert.ok((await pool.candidates()).includes('http://93.184.216.34:1984'));

  generation = 2;
  await pool.refresh();
  const refreshed = await pool.candidates();
  assert.ok(refreshed.includes('http://8.8.8.8:1984'));
  assert.ok(!refreshed.includes('http://93.184.216.34:1984'));
});

test('downloads a non-bundled L1 transaction directly from peer chunks', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-source-l1-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = 'L'.repeat(43);
  const body = Buffer.from('<html>hotdog</html>');
  const end = 800_000n;
  const start = end - BigInt(body.length) + 1n;
  const fetchImpl = async (url) => {
    if (url === 'https://index.example/graphql') {
      return jsonResponse({ data: { transactions: { edges: [{ node: {
        id,
        bundledIn: null,
        data: { size: String(body.length), type: 'text/html' }
      } }] } } });
    }
    if (url === `http://l1-peer.example:1984/tx/${id}/offset`) {
      return jsonResponse({ size: String(body.length), offset: String(end) });
    }
    if (url === `http://l1-peer.example:1984/chunk/${start}`) {
      return jsonResponse({ chunk: body.toString('base64url'), absolute_end_offset: String(end) });
    }
    return new Response('', { status: 404 });
  };
  const pool = new ArweavePeerPool({
    seeds: ['http://l1-peer.example:1984'],
    directory,
    timeoutMs: 100,
    fetchImpl,
    discoveryEnabled: false
  });
  const source = new BundlePeerSource({
    indexUrls: ['https://index.example/graphql'],
    peerPool: pool,
    timeoutMs: 100,
    maxResponseBytes: 1024,
    fetchImpl
  });

  const result = await source.get(id);

  assert.equal(result.body.toString(), body.toString());
  assert.equal(result.metadata.headers['content-type'], 'text/html');
  assert.equal(result.metadata.parentBundleId, undefined);
  assert.equal(result.source, 'arweave-peer-chunks');
});
