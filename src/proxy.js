import http from 'node:http';
import https from 'node:https';
import { cacheTtlFromHeaders, DiskCache } from './cache.js';
import { extractArnsFromHost, normalizeArnsInput } from './arns.js';
import { renderGatewayError, renderHome } from './ui.js';

const REQUEST_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const RESPONSE_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);

function filteredRequestHeaders(headers, upstreamHost) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!REQUEST_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'host') result[key] = value;
  }
  result.host = upstreamHost;
  return result;
}

function filteredResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!RESPONSE_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

function readRequestBody(request, maximumBytes = 10 * 1024 * 1024) {
  if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maximumBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function fetchFromGateway({ request, requestBody, name, gateway, timeoutMs, maxResponseBytes }) {
  const upstreamHost = `${name}.${gateway}`;
  return new Promise((resolve, reject) => {
    const upstreamRequest = https.request({
      protocol: 'https:',
      hostname: upstreamHost,
      port: 443,
      method: request.method,
      path: request.url,
      headers: filteredRequestHeaders(request.headers, upstreamHost),
      servername: upstreamHost,
      timeout: timeoutMs
    }, (upstreamResponse) => {
      const chunks = [];
      let total = 0;
      upstreamResponse.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxResponseBytes) {
          upstreamResponse.destroy(new Error(`Response exceeded ${maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on('end', () => resolve({
        statusCode: upstreamResponse.statusCode ?? 502,
        headers: filteredResponseHeaders(upstreamResponse.headers),
        body: Buffer.concat(chunks),
        sourceGateway: gateway
      }));
      upstreamResponse.on('error', reject);
    });
    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
    upstreamRequest.on('error', reject);
    if (requestBody) upstreamRequest.write(requestBody);
    upstreamRequest.end();
  });
}

function rewriteResponseHeaders(headers, { name, gateway, localHost }) {
  const result = { ...headers };
  const location = result.location;
  if (typeof location === 'string') {
    try {
      const parsed = new URL(location, `https://${name}.${gateway}`);
      if (parsed.hostname === `${name}.${gateway}`) {
        parsed.protocol = 'http:';
        parsed.host = localHost;
        result.location = parsed.toString();
      }
    } catch {
      // Preserve malformed upstream redirects instead of failing the request.
    }
  }
  delete result['strict-transport-security'];
  return result;
}

function sendResponse(response, payload, cacheStatus, context) {
  const headers = rewriteResponseHeaders(payload.headers, context);
  headers['x-local-arns-gateway'] = 'arns-local-gateway';
  headers['x-local-gateway-cache'] = cacheStatus;
  headers['x-local-gateway-upstream'] = payload.sourceGateway ?? 'disk';
  headers['content-length'] = String(payload.body.length);
  response.writeHead(payload.statusCode, headers);
  if (context.method === 'HEAD') response.end();
  else response.end(payload.body);
}

function isSuccessful(statusCode) {
  return statusCode >= 200 && statusCode < 400;
}

export function createGatewayServer(config, logger = console) {
  const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds);

  return http.createServer(async (request, response) => {
    try {
      const hostHeader = String(request.headers.host ?? '');
      const hostWithoutPort = hostHeader.split(':')[0].toLowerCase();
      const name = extractArnsFromHost(hostHeader, config.localRootHost);

      if (!name && hostWithoutPort === config.localRootHost) {
        const requestUrl = new URL(request.url, `http://${hostHeader || config.localRootHost}`);
        if (requestUrl.pathname === '/open') {
          try {
            const parsed = normalizeArnsInput(requestUrl.searchParams.get('name'), config.upstreamGateways);
            const portPart = config.port === 80 ? '' : `:${config.port}`;
            response.writeHead(302, { location: `http://${parsed.name}.${config.localRootHost}${portPart}${parsed.path}` });
            response.end();
          } catch (error) {
            const body = Buffer.from(renderHome(config, error.message));
            response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
            response.end(body);
          }
          return;
        }
        if (requestUrl.pathname === '/api/status') {
          const body = Buffer.from(JSON.stringify({
            ok: true,
            localRootHost: config.localRootHost,
            port: config.port,
            upstreamGateways: config.upstreamGateways,
            cacheDirectory: config.cacheDir
          }, null, 2));
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
          response.end(body);
          return;
        }
        const body = Buffer.from(renderHome(config));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
        response.end(body);
        return;
      }

      if (!name) {
        const body = Buffer.from('Invalid local ArNS hostname');
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
        response.end(body);
        return;
      }

      const requestBody = await readRequestBody(request);
      const cacheKey = `${name}|${request.method}|${request.url}`;
      const canCache = request.method === 'GET';
      const cached = canCache ? await cache.get(cacheKey) : null;
      const context = {
        name,
        gateway: cached?.sourceGateway ?? config.upstreamGateways[0],
        localHost: hostHeader,
        method: request.method
      };

      if (cached?.fresh) {
        sendResponse(response, cached, 'HIT', context);
        return;
      }

      const errors = [];
      let lastResponse = null;
      for (const gateway of config.upstreamGateways) {
        try {
          const upstream = await fetchFromGateway({
            request,
            requestBody,
            name,
            gateway,
            timeoutMs: config.upstreamTimeoutMs,
            maxResponseBytes: config.maxResponseBytes
          });
          if (isSuccessful(upstream.statusCode)) {
            upstream.ttlSeconds = cacheTtlFromHeaders(upstream.headers, config.cacheTtlSeconds);
            if (canCache && upstream.statusCode === 200) {
              await cache.put(cacheKey, upstream).catch((error) => logger.warn('Cache write failed:', error.message));
            }
            logger.info(`${request.method} ${name}${request.url} -> ${gateway} ${upstream.statusCode}`);
            sendResponse(response, upstream, 'MISS', { ...context, gateway });
            return;
          }
          lastResponse = upstream;
          errors.push({ gateway, error: `HTTP ${upstream.statusCode}` });
        } catch (error) {
          errors.push({ gateway, error: error.message });
        }
      }

      if (cached) {
        logger.warn(`${request.method} ${name}${request.url} -> stale cache`);
        sendResponse(response, cached, 'STALE', context);
        return;
      }

      if (lastResponse) {
        sendResponse(response, lastResponse, 'MISS', { ...context, gateway: lastResponse.sourceGateway });
        return;
      }

      const body = Buffer.from(renderGatewayError(name, errors));
      response.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      response.end(body);
    } catch (error) {
      logger.error(error);
      if (!response.headersSent) {
        const body = Buffer.from(`Local gateway error: ${error.message}`);
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
        response.end(body);
      } else {
        response.destroy(error);
      }
    }
  });
}
