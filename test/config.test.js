import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('provides multiple native endpoint defaults', () => {
  const config = loadConfig({}, process.cwd());
  assert.ok(config.solanaRpcUrls.length >= 3);
  assert.ok(config.bundleIndexUrls.length >= 2);
  assert.ok(config.arweavePeers.length >= 3);
  assert.equal(config.peerDiscoveryEnabled, true);
  assert.ok(config.peerDiscoveryMaxPeers >= 100);
});

test('accepts process-local endpoint overrides without changing global configuration', () => {
  const config = loadConfig({
    SOLANA_RPC_URLS: 'https://rpc-a.example,https://rpc-b.example',
    BUNDLE_INDEX_URLS: 'https://index.example/graphql',
    ARWEAVE_PEERS: 'http://node-a.example:1984,http://node-b.example:1984',
    PEER_DISCOVERY_ENABLED: 'false',
    PEER_DISCOVERY_MAX_PEERS: '200',
    PEER_REFRESH_INTERVAL_SECONDS: '3600'
  }, process.cwd());
  assert.deepEqual(config.solanaRpcUrls, ['https://rpc-a.example', 'https://rpc-b.example']);
  assert.deepEqual(config.bundleIndexUrls, ['https://index.example/graphql']);
  assert.deepEqual(config.arweavePeers, ['http://node-a.example:1984', 'http://node-b.example:1984']);
  assert.equal(config.peerDiscoveryEnabled, false);
  assert.equal(config.peerDiscoveryMaxPeers, 200);
  assert.equal(config.peerRefreshIntervalMs, 3_600_000);
});
