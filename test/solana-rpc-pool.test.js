import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringifyJsonWithBigInts } from '@solana/rpc-spec-types';
import { SolanaRpcPool, discoveredRpcUrl } from '../src/native/solana-rpc-pool.js';

const logger = { warn() {} };
const a = 'https://rpc-a.example/';
const b = 'https://rpc-b.example/';
function response(result) {
  return new Response(stringifyJsonWithBigInts({ jsonrpc: '2.0', id: 1, result }));
}
function pool(context, options) {
  const instance = new SolanaRpcPool({ urls: [a, b], discoveryEnabled: false, logger, ...options });
  context.after(() => instance.stop());
  return instance;
}

test('fails over per method: restricted scans do not disable ordinary account reads', async (t) => {
  const calls = [];
  const instance = pool(t, { cacheTtlMs: 0, fetchImpl: async (url, init) => {
    const { method } = JSON.parse(init.body); calls.push([url, method]);
    if (url === a && method === 'getProgramAccounts') return new Response('Requires indexed API token', { status: 403 });
    return response(method === 'getAccountInfo' ? { value: null } : []);
  } });
  assert.deepEqual(await instance.call('getProgramAccounts', ['program']), []);
  assert.deepEqual(await instance.call('getProgramAccounts', ['program']), []);
  assert.deepEqual(await instance.call('getAccountInfo', ['account']), { value: null });
  assert.equal(calls.filter(([url, method]) => url === a && method === 'getProgramAccounts').length, 1);
  assert.deepEqual(calls.at(-1), [a, 'getAccountInfo']);
});

test('429 cooldown applies across methods and expires', async (t) => {
  let clock = 1_000, limited = true;
  const calls = [];
  const instance = pool(t, { cacheTtlMs: 0, now: () => clock, fetchImpl: async (url, init) => {
    const { method } = JSON.parse(init.body); calls.push([url, method]);
    if (url === a && limited) return new Response('limited', { status: 429, headers: { 'retry-after': '40' } });
    return response(100n);
  } });
  assert.equal(await instance.call('getSlot'), 100n);
  await instance.call('getBlockHeight');
  assert.deepEqual(calls.at(-1), [b, 'getBlockHeight']);
  clock += 41_000; limited = false;
  await instance.call('getVersion');
  assert.deepEqual(calls.at(-1), [a, 'getVersion']);
});

test('coalesces identical requests, caches briefly, supports refresh and lossless integers', async (t) => {
  let clock = 1_000, calls = 0;
  const instance = pool(t, { now: () => clock, cacheTtlMs: 2_000, fetchImpl: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 5));
    return response({ lamports: 9007199254740993123n });
  } });
  const results = await Promise.all(Array.from({ length: 10 }, () => instance.call('getAccountInfo', ['same'])));
  assert.equal(calls, 1);
  assert.equal(results[0].lamports, 9007199254740993123n);
  await instance.call('getAccountInfo', ['same']); assert.equal(calls, 1);
  await instance.call('getAccountInfo', ['same'], { force: true }); assert.equal(calls, 2);
  clock += 2_001;
  await instance.call('getAccountInfo', ['same']); assert.equal(calls, 3);
  await instance.call('getAccountInfo', ['different']); assert.equal(calls, 4);
});

test('invalid parameters stop retrying, whereas unsupported method rotates; writes never run', async (t) => {
  let calls = 0, code = -32602;
  const instance = pool(t, { fetchImpl: async (url) => {
    calls++;
    return url === a ? new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message: code === -32602 ? 'Invalid params' : 'Unsupported method' } })) : response('ok');
  } });
  await assert.rejects(instance.call('getAccountInfo'), e => e.permanent && e.rpcCode === -32602);
  assert.equal(calls, 1);
  code = -32601;
  assert.equal(await instance.call('getVersion'), 'ok'); assert.equal(calls, 3);
  await assert.rejects(instance.call('sendTransaction'), /read-only/); assert.equal(calls, 3);
});

test('timeout switches endpoint and failed results are not cached', async (t) => {
  let calls = 0;
  const instance = pool(t, { timeoutMs: 20, requestTimeoutMs: 300, fetchImpl: async (url, init) => {
    calls++;
    if (url === a) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    return response('backup');
  } });
  // Keep the synthetic test alive: AbortSignal.timeout deliberately has an unref timer.
  const keepAlive = setTimeout(() => {}, 1_000); t.after(() => clearTimeout(keepAlive));
  assert.equal(await instance.call('getHealth'), 'backup'); assert.equal(calls, 2);
});

test('discovery filters private/gossip addresses, deduplicates BFS, checks network and persists hints', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'solana-rpc-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = 'http://8.8.8.8:8899/', second = 'http://9.9.9.9:8899/', wrong = 'http://1.1.1.1:8899/';
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { method } = JSON.parse(init.body); calls.push([url, method]);
    if (method === 'getGenesisHash') return response(url === wrong ? 'another-chain' : 'mainnet');
    if (method === 'getClusterNodes') return response(url === a ? [
      { rpc: '8.8.8.8:8899' }, { rpc: '8.8.8.8:8899' }, { rpc: '127.0.0.1:8899' },
      { rpc: '192.168.1.1:8899' }, { rpc: null, gossip: '4.4.4.4:8001' }, { rpc: '1.1.1.1:8899' }
    ] : url === first ? [{ rpc: '9.9.9.9:8899' }] : []);
    return response('available');
  };
  const instance = pool(t, { urls: [a], directory, discoveryEnabled: true, fetchImpl });
  await instance.discover({ force: true });
  assert.ok(instance.records.has(first)); assert.ok(instance.records.has(second));
  assert.equal(instance.records.has(wrong), false);
  assert.equal(calls.filter(([url, method]) => url === first && method === 'getGenesisHash').length, 1);
  assert.ok(!calls.some(([url]) => url.includes('127.0.0.1') || url.includes('4.4.4.4')));
  const snapshot = JSON.parse(await fs.readFile(instance.file, 'utf8'));
  assert.deepEqual(snapshot.addresses.sort(), ['8.8.8.8:8899', '9.9.9.9:8899']);
  const reloaded = pool(t, { urls: [a], directory, discoveryEnabled: true, fetchImpl });
  await reloaded.load();
  assert.equal(reloaded.candidates('getHealth').length, 1, 'snapshot nodes must be reverified');
  await reloaded.discover({ force: true });
  assert.equal(reloaded.candidates('getHealth').length, 3);
});

test('current request uses a discovered RPC without waiting for unrelated slow peers', async (t) => {
  const first = 'http://8.8.8.8:8899/';
  const instance = pool(t, { urls: [a], discoveryEnabled: true, timeoutMs: 500, requestTimeoutMs: 300, fetchImpl: async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === 'getGenesisHash') {
      if (url === 'http://9.9.9.9:8899/') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      return response('mainnet');
    }
    if (method === 'getClusterNodes') return response(url === a ? [{ rpc: '8.8.8.8:8899' }, { rpc: '9.9.9.9:8899' }] : []);
    if (url === a) return new Response('unavailable', { status: 503 });
    return response('new-node');
  } });
  const keepAlive = setTimeout(() => {}, 1_000); t.after(() => clearTimeout(keepAlive));
  assert.equal(await instance.call('getHealth'), 'new-node');
  assert.equal(instance.lastEndpoint, first);
  assert.ok(instance.discoveryPromise, 'BFS continues independently of the successful request');
});

test('only literal public IPv4 RPC addresses are eligible for automatic discovery', () => {
  for (const value of ['localhost:8899', '127.0.0.1:8899', '10.1.2.3:8899', '100.64.1.1:8899',
    '169.254.169.254:80', '172.16.1.1:8899', '192.168.0.1:8899', '192.0.2.1:8899',
    '198.51.100.1:80', '203.0.113.1:80', '224.0.0.1:80', '8.8.8.8:99999', 'https://8.8.8.8:8899', null]) {
    assert.equal(discoveredRpcUrl(value), null, String(value));
  }
  assert.equal(discoveredRpcUrl('8.8.8.8:8899'), 'http://8.8.8.8:8899/');
});

test('saved network and RPC hints recover when original seeds are down; total outages preserve the snapshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'solana-rpc-offline-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const file = path.join(directory, 'solana-rpc-pool.json');
  await fs.writeFile(file, JSON.stringify({ genesisHash: genesis, addresses: ['8.8.8.8:8899'] }));
  let offline = false;
  const instance = pool(t, { urls: [a], directory, discoveryEnabled: true, fetchImpl: async (url, init) => {
    if (url === a || offline) throw new Error('offline');
    const { method } = JSON.parse(init.body);
    return response(method === 'getGenesisHash' ? genesis : method === 'getClusterNodes' ? [] : 'snapshot-rpc');
  } });
  await instance.discover({ force: true });
  assert.equal(instance.candidates('getHealth').length, 2);
  assert.equal(await instance.call('getHealth'), 'snapshot-rpc');
  const saved = await fs.readFile(file, 'utf8');
  offline = true;
  await instance.discover({ force: true });
  await instance.discover({ force: true });
  assert.equal(await fs.readFile(file, 'utf8'), saved);
  assert.ok(instance.records.has('http://8.8.8.8:8899/'));
});

test('total query deadline bounds multiple slow endpoints', async (t) => {
  let calls = 0;
  const instance = pool(t, { timeoutMs: 500, requestTimeoutMs: 40, fetchImpl: async (url, init) => {
    calls++;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const keepAlive = setTimeout(() => {}, 1_000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(instance.call('getHealth'), /No available Solana RPC/);
  assert.equal(calls, 1);
});

test('cache has a byte budget, drops expired entries and disabling cache still coalesces', async (t) => {
  let clock = 1_000, calls = 0;
  const instance = pool(t, { now: () => clock, fetchImpl: async () => { calls++; return response('12345678'); } });
  instance.maxCacheBytes = 15;
  await instance.call('getHealth', ['a']);
  await instance.call('getHealth', ['b']);
  assert.equal(instance.cache.size, 1);
  assert.ok(instance.cacheBytes <= 15);
  clock += 2_001;
  await instance.call('getHealth', ['c']);
  assert.equal(instance.cache.size, 1);
  instance.cacheTtlMs = 0;
  clock += 2_001;
  await Promise.all([instance.call('getHealth', ['d']), instance.call('getHealth', ['d'])]);
  assert.equal(instance.cache.size, 0); assert.equal(calls, 4);
});

test('exhausted query deadline still starts bounded background RPC discovery', async (t) => {
  let discoveries = 0;
  const instance = pool(t, { urls: [a], discoveryEnabled: true, timeoutMs: 500, requestTimeoutMs: 20,
    fetchImpl: async (url, init) => new Promise((resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
  instance.discover = async () => { discoveries++; return []; };
  const keepAlive = setTimeout(() => {}, 1_000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(instance.call('getHealth'), /No available Solana RPC/);
  assert.equal(discoveries, 1, 'a slow seed must not prevent discovery for later requests');
});
