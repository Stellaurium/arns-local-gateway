import http from 'node:http';
import { extractArnsFromHost, normalizeArnsInput } from '../arns.js';
import { renderHome } from '../ui.js';
import { NativeArnsResolver } from './arns-resolver.js';
import { ImmutableContentStore } from './content-store.js';
import { parseManifest, resolveManifestPath } from './manifest.js';
import { BundlePeerSource } from './bundle-peer-source.js';
import { ArweavePeerPool } from './peer-pool.js';

function sendBuffer(response, statusCode, body, headers = {}, method = 'GET') {
  response.writeHead(statusCode, { ...headers, 'content-length': String(body.length) });
  if (method === 'HEAD') response.end();
  else response.end(body);
}

function publicMetadata(result) {
  const headers = result.metadata.headers ?? {};
  return Object.fromEntries(Object.entries({
    'content-type': headers['content-type'] ?? 'application/octet-stream',
    etag: headers.etag,
    'content-digest': headers['content-digest'],
    'cache-control': 'public, max-age=31536000, immutable',
    'x-local-content-source': result.source,
    'x-local-data-id': result.metadata.id
  }).filter(([, value]) => value !== undefined));
}

export function createNativeGatewayServer(config, logger = console) {
  const resolver = new NativeArnsResolver({
    rpcUrls: config.solanaRpcUrls,
    dataDirectory: config.dataDir,
    logger
  });
  const peerPool = new ArweavePeerPool({
    seeds: config.arweavePeers,
    directory: config.dataDir,
    timeoutMs: config.arweavePeerTimeoutMs,
    discoveryEnabled: config.peerDiscoveryEnabled,
    maxPeers: config.peerDiscoveryMaxPeers,
    maxDepth: config.peerDiscoveryMaxDepth,
    discoveryConcurrency: config.peerDiscoveryConcurrency,
    refreshIntervalMs: config.peerRefreshIntervalMs,
    logger
  });
  peerPool.startPeriodicRefresh();
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
    }),
    logger
  });

  const server = http.createServer(async (request, response) => {
    try {
      const hostHeader = String(request.headers.host ?? '');
      const hostWithoutPort = hostHeader.split(':')[0].toLowerCase();
      const name = extractArnsFromHost(hostHeader, config.localRootHost);
      const requestUrl = new URL(request.url, `http://${hostHeader || config.localRootHost}`);

      if (!name && hostWithoutPort === config.localRootHost) {
        if (requestUrl.pathname === '/open') {
          try {
            const parsed = normalizeArnsInput(requestUrl.searchParams.get('name'), config.upstreamGateways);
            const portPart = config.port === 80 ? '' : `:${config.port}`;
            response.writeHead(302, { location: `http://${parsed.name}.${config.localRootHost}${portPart}${parsed.path}` });
            response.end();
          } catch (error) {
            const body = Buffer.from(renderHome(config, error.message));
            sendBuffer(response, 400, body, { 'content-type': 'text/html; charset=utf-8' }, request.method);
          }
          return;
        }
        if (requestUrl.pathname === '/api/status') {
          const body = Buffer.from(JSON.stringify({
            ok: true,
            mode: 'native',
            arnsResolution: 'direct-solana-rpc',
            solanaRpcUrls: config.solanaRpcUrls,
            bundleIndexUrls: config.bundleIndexUrls,
            arweavePeers: config.arweavePeers,
            peerDiscovery: {
              enabled: config.peerDiscoveryEnabled,
              maxPeers: config.peerDiscoveryMaxPeers,
              maxDepth: config.peerDiscoveryMaxDepth,
              refreshIntervalSeconds: Math.round(config.peerRefreshIntervalMs / 1000),
              currentPoolSize: peerPool.records.size,
              snapshotFile: peerPool.file
            },
            dataProviderUrls: config.dataProviderUrls,
            dataDirectory: config.dataDir
          }, null, 2));
          sendBuffer(response, 200, body, { 'content-type': 'application/json; charset=utf-8' }, request.method);
          return;
        }
        if (requestUrl.pathname === '/api/resolve') {
          const parsed = normalizeArnsInput(requestUrl.searchParams.get('name'), config.upstreamGateways);
          const resolution = await resolver.resolve(parsed.name, { force: requestUrl.searchParams.get('refresh') === '1' });
          const body = Buffer.from(JSON.stringify(resolution, null, 2));
          sendBuffer(response, 200, body, { 'content-type': 'application/json; charset=utf-8' }, request.method);
          return;
        }
        const body = Buffer.from(renderHome(config));
        sendBuffer(response, 200, body, { 'content-type': 'text/html; charset=utf-8' }, request.method);
        return;
      }

      if (!name) {
        sendBuffer(response, 400, Buffer.from('Invalid local ArNS hostname'), { 'content-type': 'text/plain; charset=utf-8' }, request.method);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        sendBuffer(response, 405, Buffer.from('Native ArNS content is read-only'), { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, request.method);
        return;
      }

      const resolution = await resolver.resolve(name);
      if (resolution.targetProtocol !== 0) {
        throw new Error(`Target protocol ${resolution.targetProtocol} is not supported yet`);
      }

      const target = await store.get(resolution.targetId);
      const targetType = target.metadata.headers?.['content-type'] ?? '';
      const manifest = parseManifest(target.body, targetType);
      let served = target;
      let manifestResolution = null;
      if (manifest) {
        manifestResolution = resolveManifestPath(manifest, request.url);
        if (!manifestResolution) {
          sendBuffer(response, 404, Buffer.from('Manifest path not found'), { 'content-type': 'text/plain; charset=utf-8' }, request.method);
          return;
        }
        served = await store.get(manifestResolution.id);
      } else if (requestUrl.pathname !== '/') {
        sendBuffer(response, 404, Buffer.from('This ArNS target is not a path manifest'), { 'content-type': 'text/plain; charset=utf-8' }, request.method);
        return;
      }

      const headers = publicMetadata(served);
      headers['x-local-arns-name'] = name;
      headers['x-local-arns-target-id'] = resolution.targetId;
      headers['x-local-arns-resolution-source'] = resolution.source;
      headers['x-local-arns-ttl-seconds'] = String(resolution.ttlSeconds);
      if (manifestResolution) headers['x-local-manifest-path'] = manifestResolution.path;
      sendBuffer(response, 200, served.body, headers, request.method);
    } catch (error) {
      logger.error(error);
      sendBuffer(response, 502, Buffer.from(`Native gateway error: ${error.message}`), { 'content-type': 'text/plain; charset=utf-8' }, request.method);
    }
  });

  server.nativeServices = { resolver, store, peerPool };
  server.once('close', () => peerPool.stopPeriodicRefresh());
  return server;
}
