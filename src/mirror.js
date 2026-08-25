import { loadConfig } from './config.js';
import { normalizeArnsInput } from './arns.js';
import { NativeArnsResolver } from './native/arns-resolver.js';
import { ImmutableContentStore } from './native/content-store.js';
import { manifestDataIds, parseManifest } from './native/manifest.js';
import { BundlePeerSource } from './native/bundle-peer-source.js';
import { ArweavePeerPool } from './native/peer-pool.js';

const config = loadConfig();
const parsed = normalizeArnsInput(process.argv[2], config.upstreamGateways);
const resolver = new NativeArnsResolver({ rpcUrls: config.solanaRpcUrls, dataDirectory: config.dataDir });
const peerPool = new ArweavePeerPool({
  seeds: config.arweavePeers,
  directory: config.dataDir,
  timeoutMs: config.arweavePeerTimeoutMs,
  discoveryEnabled: config.peerDiscoveryEnabled,
  maxPeers: config.peerDiscoveryMaxPeers,
  maxDepth: config.peerDiscoveryMaxDepth,
  discoveryConcurrency: config.peerDiscoveryConcurrency,
  refreshIntervalMs: config.peerRefreshIntervalMs
});
const store = new ImmutableContentStore({
  directory: config.dataDir,
  providerUrls: config.dataProviderUrls,
  timeoutMs: config.dataProviderTimeoutMs,
  maxResponseBytes: config.maxResponseBytes,
  bundleSource: new BundlePeerSource({
    indexUrls: config.bundleIndexUrls,
    peerPool,
    timeoutMs: config.arweavePeerTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    peerRequestConcurrency: config.peerRequestConcurrency
  })
});

console.log(`Resolving ${parsed.name} directly through Solana RPC...`);
const resolution = await resolver.resolve(parsed.name, { force: true });
console.log(`Target: ${resolution.targetId}; TTL: ${resolution.ttlSeconds}s; RPC: ${resolution.rpcUrl}`);
if (resolution.targetProtocol !== 0) throw new Error(`Unsupported target protocol: ${resolution.targetProtocol}`);

const target = await store.get(resolution.targetId);
const manifest = parseManifest(target.body, target.metadata.headers?.['content-type'] ?? '');
if (!manifest) {
  console.log(`Stored single immutable object (${target.body.length} bytes).`);
  process.exit(0);
}

const ids = manifestDataIds(manifest);
console.log(`Manifest contains ${ids.length} immutable objects.`);
let completed = 0;
for (const id of ids) {
  const item = await store.get(id);
  completed += 1;
  console.log(`[${completed}/${ids.length}] ${id} ${item.body.length} bytes (${item.source})`);
}
console.log(`Mirror complete: ${parsed.name} -> ${resolution.targetId}`);
