import path from 'node:path';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback) {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const upstreamGateways = (env.UPSTREAM_GATEWAYS ?? 'ar.anyone.tech,ar.io,arweave.dev,turbo-gateway.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (upstreamGateways.length === 0) {
    throw new Error('UPSTREAM_GATEWAYS must contain at least one hostname');
  }

  for (const host of upstreamGateways) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) {
      throw new Error(`Invalid upstream gateway hostname: ${host}`);
    }
  }

  const solanaRpcUrls = (env.SOLANA_RPC_URLS ?? 'https://solana-rpc.publicnode.com,https://public.rpc.solanavibestation.com,https://solana-mainnet.gateway.tatum.io,https://solana.api.pocket.network')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const dataProviderUrls = (env.DATA_PROVIDER_URLS ?? 'https://ar.anyone.tech/raw/{id},https://arweave.net/raw/{id},https://turbo-gateway.com/raw/{id}')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const bundleIndexUrls = (env.BUNDLE_INDEX_URLS ?? 'https://arweave-search.goldsky.com/graphql,https://turbo-gateway.com/graphql')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const arweavePeers = (env.ARWEAVE_PEERS ?? 'http://168.119.211.60:1984,http://142.4.54.138:1984,http://38.29.227.69:1984,http://38.29.227.76:1984,http://49.12.135.160:1984')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (solanaRpcUrls.some((value) => !/^https?:\/\//i.test(value))) {
    throw new Error('SOLANA_RPC_URLS must contain HTTP(S) URLs');
  }
  if (dataProviderUrls.some((value) => !/^https?:\/\//i.test(value) || !value.includes('{id}'))) {
    throw new Error('DATA_PROVIDER_URLS entries must be HTTP(S) URL templates containing {id}');
  }
  if ([...bundleIndexUrls, ...arweavePeers].some((value) => !/^https?:\/\//i.test(value))) {
    throw new Error('BUNDLE_INDEX_URLS and ARWEAVE_PEERS must contain HTTP(S) URLs');
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port: positiveInteger(env.PORT, 4318),
    localRootHost: (env.LOCAL_ROOT_HOST ?? 'localhost').toLowerCase(),
    gatewayMode: (env.GATEWAY_MODE ?? 'native').toLowerCase(),
    solanaRpcUrls,
    bundleIndexUrls,
    arweavePeers,
    dataProviderUrls,
    upstreamGateways,
    upstreamTimeoutMs: positiveInteger(env.UPSTREAM_TIMEOUT_MS, 10_000),
    dataProviderTimeoutMs: positiveInteger(env.DATA_PROVIDER_TIMEOUT_MS, 30_000),
    arweavePeerTimeoutMs: positiveInteger(env.ARWEAVE_PEER_TIMEOUT_MS, 10_000),
    peerDiscoveryEnabled: booleanValue(env.PEER_DISCOVERY_ENABLED, true),
    peerDiscoveryMaxPeers: positiveInteger(env.PEER_DISCOVERY_MAX_PEERS, 512),
    peerDiscoveryMaxDepth: positiveInteger(env.PEER_DISCOVERY_MAX_DEPTH, 2),
    peerDiscoveryConcurrency: positiveInteger(env.PEER_DISCOVERY_CONCURRENCY, 8),
    peerRequestConcurrency: positiveInteger(env.PEER_REQUEST_CONCURRENCY, 8),
    peerRefreshIntervalMs: positiveInteger(env.PEER_REFRESH_INTERVAL_SECONDS, 21_600) * 1000,
    cacheTtlSeconds: positiveInteger(env.CACHE_TTL_SECONDS, 900),
    maxResponseBytes: positiveInteger(env.MAX_RESPONSE_MB, 64) * 1024 * 1024,
    cacheDir: path.resolve(cwd, '.cache'),
    dataDir: path.resolve(cwd, env.DATA_DIR ?? '.data')
  };
}
