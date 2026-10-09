import http from 'node:http';
import crypto from 'node:crypto';
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';
import { extractArnsFromHost, normalizeArnsInput } from '../arns.js';
import { renderHome } from '../ui.js';
import { NativeArnsResolver } from './arns-resolver.js';
import { ImmutableContentStore } from './content-store.js';
import { parseManifest, resolveManifestPath } from './manifest.js';
import { BundlePeerSource } from './bundle-peer-source.js';
import { ArweavePeerPool } from './peer-pool.js';
import { createConfiguredSolanaRpcPool, READ_METHODS } from './solana-rpc-pool.js';
import { RPC_PATH, BRIDGE_PATH, bridgeEnabled, bridgeScript, injectBridge } from './rpc-bridge.js';
import { decodeStoredContent } from './content-encoding.js';

function sendBuffer(response, statusCode, body, headers = {}, method = 'GET') {
  response.writeHead(statusCode, { 'cache-control': 'no-store', ...headers, 'content-length': String(body.length) });
  if (method === 'HEAD') response.end();
  else response.end(body);
}

function publicMetadata(result) {
  const headers = result.metadata.headers ?? {};
  return Object.fromEntries(Object.entries({
    'content-type': headers['content-type'] ?? 'application/octet-stream',
    etag: headers.etag,
    'content-digest': headers['content-digest'],
    'cache-control': 'no-cache, must-revalidate',
    'x-local-content-source': result.source,
    'x-local-data-id': result.metadata.id
  }).filter(([, value]) => value !== undefined));
}

export function createNativeGatewayServer(config, logger = console) {
  const rpcPool = createConfiguredSolanaRpcPool(config, logger);
  rpcPool.start();
  const resolver = new NativeArnsResolver({
    rpcUrls: config.solanaRpcUrls,
    rpcPool,
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

      if ((name || hostWithoutPort === config.localRootHost) && requestUrl.pathname === RPC_PATH) {
        if (request.method !== 'POST') {
          sendBuffer(response, 405, Buffer.from('Use POST'), { allow: 'POST' }, request.method); return;
        }
        if (request.headers.origin && request.headers.origin !== requestUrl.origin) {
          sendBuffer(response, 403, Buffer.from('RPC requires a same-origin request')); return;
        }
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 65536) {
            sendBuffer(response, 413, Buffer.from('RPC request exceeds 64 KiB')); return;
          }
          chunks.push(chunk);
        }
        let payload;
        try { payload = parseJsonWithBigInts(Buffer.concat(chunks).toString('utf8')); }
        catch { sendBuffer(response, 400, Buffer.from('Invalid JSON')); return; }
        const execute = async (p) => {
          if (!p || p.jsonrpc !== '2.0' || !READ_METHODS.has(p.method) || !Array.isArray(p.params ?? []) ||
              !(typeof p.id === 'string' || typeof p.id === 'number' || typeof p.id === 'bigint' || p.id === null)) {
            return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected a supported read-only JSON-RPC request with an id' } };
          }
          try { return { jsonrpc: '2.0', id: p.id, result: await rpcPool.call(p.method, p.params ?? []) }; }
          catch (error) { return { jsonrpc: '2.0', id: p.id, error: { code: error.permanent ? error.rpcCode : -32000,
            message: error.permanent ? 'Invalid Solana RPC parameters' : 'Solana RPC unavailable; retry after cooldown' } }; }
        };
        if (Array.isArray(payload) && (!payload.length || payload.length > 20)) {
          sendBuffer(response, 400, Buffer.from('RPC batches must contain 1 to 20 requests')); return;
        }
        const result = Array.isArray(payload) ? await Promise.all(payload.map(execute)) : await execute(payload);
        sendBuffer(response, 200, Buffer.from(stringifyJsonWithBigInts(result)), { 'content-type': 'application/json; charset=utf-8' }); return;
      }
      if (name && requestUrl.pathname === BRIDGE_PATH && bridgeEnabled(name, config.solanaRpcBridgeNames)) {
        if (!['GET','HEAD'].includes(request.method)) {
          sendBuffer(response, 405, Buffer.from('Use GET'), { allow: 'GET, HEAD' }, request.method); return;
        }
        sendBuffer(response, 200, Buffer.from(bridgeScript(config)), { 'content-type': 'application/javascript; charset=utf-8' }, request.method); return;
      }

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
            solanaRpcUrls: config.solanaRpcUrls.map(url => new URL(url).origin),
            solanaRpcPool: rpcPool.status(),
            solanaRpcBridgeNames: config.solanaRpcBridgeNames,
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

      const target = await decodeStoredContent(await store.get(resolution.targetId), config.maxResponseBytes);
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
        served = await decodeStoredContent(await store.get(manifestResolution.id), config.maxResponseBytes);
      } else if (requestUrl.pathname !== '/') {
        sendBuffer(response, 404, Buffer.from('This ArNS target is not a path manifest'), { 'content-type': 'text/plain; charset=utf-8' }, request.method);
        return;
      }

      const headers = publicMetadata(served);
      let body = served.body;
      if ((headers['content-type'].includes('text/html') || headers['content-type'].includes('application/xhtml+xml')) &&
          bridgeEnabled(name, config.solanaRpcBridgeNames)) {
        body = injectBridge(body);
        delete headers['content-digest'];
        headers['x-local-rpc-bridge'] = 'solana';
      }
      // The validator includes Target as well as bytes: revalidation must resolve the name first.
      headers.etag = `"${crypto.createHash('sha256').update(resolution.targetId).update(body).digest('base64url')}"`;
      headers['x-local-arns-name'] = name;
      headers['x-local-arns-target-id'] = resolution.targetId;
      headers['x-local-arns-resolution-source'] = resolution.source;
      headers['x-local-arns-ttl-seconds'] = String(resolution.ttlSeconds);
      if (resolution.source === 'resolution-cache-stale') {
        headers['cache-control'] = 'no-store';
        headers.warning = '110 local-gateway "ArNS resolution is stale"';
      }
      if (manifestResolution) headers['x-local-manifest-path'] = manifestResolution.path;
      const validators = String(request.headers['if-none-match'] ?? '').split(',').map(v => v.trim().replace(/^W\//,''));
      if (validators.includes('*') || validators.includes(headers.etag)) {
        response.writeHead(304, headers); response.end(); return;
      }
      sendBuffer(response, 200, body, headers, request.method);
    } catch (error) {
      logger.error(error);
      const status = error.code === 'ARNS_NOT_FOUND' ? 404 : 502;
      sendBuffer(response, status, Buffer.from(`Native gateway error: ${error.message}`), { 'content-type': 'text/plain; charset=utf-8' }, request.method);
    }
  });

  server.nativeServices = { resolver, store, peerPool, rpcPool };
  server.once('close', () => { peerPool.stopPeriodicRefresh(); rpcPool.stop(); });
  return server;
}
