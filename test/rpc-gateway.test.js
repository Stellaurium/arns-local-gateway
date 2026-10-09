import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { parseJsonWithBigInts } from '@solana/rpc-spec-types';
import { loadConfig } from '../src/config.js';
import { createNativeGatewayServer } from '../src/native/gateway.js';
import { NativeArnsResolver } from '../src/native/arns-resolver.js';
import { bridgeScript, RPC_PATH, BRIDGE_PATH } from '../src/native/rpc-bridge.js';

const logger = { warn() {}, error() {} };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-gateway-test-'));
  const config = loadConfig({ DATA_DIR: directory, PEER_DISCOVERY_ENABLED: 'false', SOLANA_RPC_DISCOVERY_ENABLED: 'false' });
  const server = createNativeGatewayServer(config, logger);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.nativeServices.rpcPool.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const host = `cyberleek.localhost:${server.address().port}`;
  let target = 'A'.repeat(43), source = 'resolution-cache', resolutions = 0;
  server.nativeServices.resolver.resolve = async () => {
    resolutions++;
    return { targetId: target, targetProtocol: 0, ttlSeconds: 900, source };
  };
  server.nativeServices.store.get = async id => ({
    body: Buffer.from('<html><head><title>Fixture</title></head><body><script>app()</script></body></html>'),
    metadata: { id, headers: { 'content-type': 'text/html', 'content-digest': 'obsolete-digest' } }, source: 'immutable-store'
  });
  // node:http preserves an explicit Host; fetch can replace this forbidden header.
  const request = (pathname = '/', init = {}) => new Promise((resolve, reject) => {
    const req = http.request(url + pathname, { method: init.method ?? 'GET', headers: { host, ...init.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(res.statusCode === 304 ? null : Buffer.concat(chunks), {
        status: res.statusCode, headers: res.headers
      })));
    });
    req.on('error', reject); req.end(init.body);
  });
  return { server, request, host, config, setTarget: value => { target = value; }, setSource: value => { source = value; }, resolutions: () => resolutions };
}

test('name routes revalidate rather than freeze; target changes invalidate ETag before 304', async (t) => {
  const f = await fixture(t);
  const first = await f.request();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache, must-revalidate');
  assert.equal(first.headers.get('x-local-content-source'), 'immutable-store');
  assert.equal(first.headers.get('x-local-rpc-bridge'), 'solana');
  assert.equal(first.headers.get('content-digest'), null);
  const html = await first.text();
  assert.ok(html.indexOf(BRIDGE_PATH) < html.indexOf('app()'));
  const etag = first.headers.get('etag');
  assert.equal((await f.request('/', { headers: { 'if-none-match': `W/${etag}` } })).status, 304);
  assert.equal(f.resolutions(), 2, 'resolve name even for a conditional request');
  f.setTarget('B'.repeat(43));
  const changed = await f.request('/', { headers: { 'if-none-match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  f.setSource('resolution-cache-stale');
  const stale = await f.request();
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.match(stale.headers.get('warning'), /stale/);
  const head = await f.request('/', { method: 'HEAD' });
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('local JSON-RPC preserves ids and 64-bit values; never caches HTTP responses', async (t) => {
  const f = await fixture(t);
  f.server.nativeServices.rpcPool.call = async () => ({ lamports: 9007199254740993123n });
  const response = await f.request(RPC_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://${f.host}` },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 'caller-a', method: 'getAccountInfo', params: ['account'] },
      { jsonrpc: '2.0', id: 99, method: 'getSlot' }])
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const results = parseJsonWithBigInts(await response.text());
  assert.equal(results[0].id, 'caller-a'); assert.equal(results[1].id, 99n);
  assert.equal(results[0].result.lamports, 9007199254740993123n);
});

test('local RPC rejects foreign origins, writes, oversized bodies and malformed batches', async (t) => {
  const f = await fixture(t); let calls = 0;
  f.server.nativeServices.rpcPool.call = async () => { calls++; return 'ok'; };
  const post = (body, headers = {}) => f.request(RPC_PATH, { method: 'POST', body, headers });
  assert.equal((await post('{}', { origin: 'https://foreign.example' })).status, 403);
  const forbidden = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['payload'] }));
  assert.equal((await forbidden.json()).error.code, -32600); assert.equal(calls, 0);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('invalid')).status, 400);
  assert.equal((await post('x'.repeat(65537))).status, 413);
  assert.equal((await f.request(RPC_PATH)).status, 405);
  assert.equal(calls, 0);
});

test('browser bridge routes only configured Solana read methods and preserves aborts', async () => {
  const calls = [], config = loadConfig({});
  const original = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
  const context = { window: { fetch: original }, Request, URL, location: { href: 'http://cyberleek.localhost:4318/' } };
  vm.runInNewContext(bridgeScript(config), context);
  const signal = new AbortController().signal;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' });
  await context.window.fetch('https://api.mainnet-beta.solana.com', { method: 'POST', body, signal });
  assert.equal(calls.at(-1).url, RPC_PATH); assert.equal(calls.at(-1).init.signal, signal);
  await context.window.fetch(new Request('https://api.mainnet-beta.solana.com', { method: 'POST', body }));
  assert.equal(calls.at(-1).url, RPC_PATH);
  await context.window.fetch('https://unrelated.example', { method: 'POST', body });
  assert.equal(calls.at(-1).url, 'https://unrelated.example');
  const write = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'sendTransaction' });
  await context.window.fetch('https://api.mainnet-beta.solana.com', { method: 'POST', body: write });
  assert.equal(calls.at(-1).url, 'https://api.mainnet-beta.solana.com');
  context.window.fetch = original;
  context.window.fetch = async () => { throw new Error('local request failed'); };
  vm.runInNewContext(bridgeScript(config), context);
  await assert.rejects(context.window.fetch('https://api.mainnet-beta.solana.com', { method: 'POST', body }), /local request failed/);
});

test('ArNS honors TTL, uses stale resolution offline, backs off and supports forced refresh', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arns-resolution-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0, forced = false;
  const rpcPool = { async call(method, params, options) { calls++; forced = options.force; throw new Error('offline'); } };
  const resolver = new NativeArnsResolver({ rpcUrls: [], rpcPool, dataDirectory: directory, logger });
  const record = { name: 'fixture', targetId: 'A'.repeat(43), ttlSeconds: 900, resolvedAt: Date.now(), rpcUrl: 'https://rpc.example/private?api-key=secret' };
  await resolver.writeCached('fixture', record);
  const fresh = await resolver.resolve('fixture');
  assert.equal(fresh.source, 'resolution-cache'); assert.equal(calls, 0);
  assert.equal(fresh.rpcUrl, 'https://rpc.example');
  await resolver.writeCached('fixture', { ...record, resolvedAt: Date.now() - 901_000 });
  const offline = await Promise.all([resolver.resolve('fixture'), resolver.resolve('fixture')]);
  assert.equal(offline[0].source, 'resolution-cache-stale'); assert.equal(calls, 1);
  await resolver.resolve('fixture'); assert.equal(calls, 1);
  await resolver.resolve('fixture', { force: true }); assert.equal(calls, 2); assert.equal(forced, true);
});

test('serves tagged gzip HTML as real HTML, including old cached metadata and RPC injection', async (t) => {
  const f = await fixture(t);
  const compressed = gzipSync(Buffer.from('<html><head><title>Compressed fixture</title></head><body>Readable page</body></html>'));
  f.server.nativeServices.store.get = async id => ({ body: compressed, source: 'immutable-store',
    metadata: { id, tags: [{ name: 'Content-Encoding', value: 'gzip' }], headers: { 'content-type': 'text/html' } } });
  const response = await f.request();
  const html = await response.text();
  assert.match(html, /Readable page/);
  assert.match(html, /solana-rpc-bridge/);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(compressed[0], 0x1f, 'permanent original is not modified');
});

test('gzip manifests route to files rather than being mistaken for a single binary object', async (t) => {
  const f = await fixture(t);
  const indexId = 'B'.repeat(43);
  const manifest = { manifest: 'arweave/paths', version: '0.2.0', index: { path: 'index.html' }, paths: { 'index.html': { id: indexId } } };
  f.server.nativeServices.store.get = async id => id === indexId
    ? { body: Buffer.from('<html><body>Manifest works</body></html>'), source: 'immutable-store', metadata: { id, headers: { 'content-type': 'text/html' } } }
    : { body: gzipSync(Buffer.from(JSON.stringify(manifest))), source: 'immutable-store', metadata: { id, headers: { 'content-type': 'application/x.arweave-manifest+json', 'content-encoding': 'gzip' } } };
  assert.match(await (await f.request()).text(), /Manifest works/);
});

test('a confirmed missing ArNS record is not silently served from an obsolete cached name', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arns-missing-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resolver = new NativeArnsResolver({ rpcUrls: [], dataDirectory: directory, logger,
    rpcPool: { async call() { return { context: { slot: 1n }, value: null }; } } });
  await resolver.writeCached('missing', { name: 'missing', targetId: 'A'.repeat(43), ttlSeconds: 1, resolvedAt: Date.now() - 5000 });
  await assert.rejects(resolver.resolve('missing'), error => error.code === 'ARNS_NOT_FOUND');
});

test('forced resolution does not get swallowed by a concurrent fresh-cache read', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arns-forced-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const resolver = new NativeArnsResolver({ rpcUrls: [], dataDirectory: directory, logger,
    rpcPool: { async call() { calls++; throw new Error('offline'); } } });
  await resolver.writeCached('fixture', { targetId: 'A'.repeat(43), ttlSeconds: 900, resolvedAt: Date.now() });
  await Promise.all([resolver.resolve('fixture'), resolver.resolve('fixture', { force: true })]);
  assert.equal(calls, 1);
});
