import { loadConfig } from './config.js';

const config = loadConfig();

async function timedFetch(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, durationMs: Math.round(performance.now() - startedAt) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSolana(url) {
  try {
    const { response, durationMs } = await timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' })
    });
    const payload = await response.json();
    return { type: 'solana-rpc', url, ok: response.ok && payload.result === 'ok', status: response.status, durationMs, detail: payload.result ?? payload.error?.message };
  } catch (error) {
    return { type: 'solana-rpc', url, ok: false, detail: error.message };
  }
}

async function checkBundleIndex(url) {
  try {
    const { response, durationMs } = await timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query { transactions(first: 1) { edges { node { id } } } }' })
    });
    const payload = await response.json();
    const ok = response.ok && Array.isArray(payload?.data?.transactions?.edges);
    return { type: 'bundle-index', url, ok, status: response.status, durationMs, detail: payload.errors?.[0]?.message };
  } catch (error) {
    return { type: 'bundle-index', url, ok: false, detail: error.message };
  }
}

async function checkArweavePeer(url) {
  try {
    const { response, durationMs } = await timedFetch(`${url}/info`);
    const payload = await response.json();
    const ok = response.ok && payload.network === 'arweave.N.1';
    return { type: 'arweave-peer', url, ok, status: response.status, durationMs, detail: ok ? `height=${payload.height}, release=${payload.release}` : payload.network };
  } catch (error) {
    return { type: 'arweave-peer', url, ok: false, detail: error.message };
  }
}

const results = await Promise.all([
  ...config.solanaRpcUrls.map(checkSolana),
  ...config.bundleIndexUrls.map(checkBundleIndex),
  ...config.arweavePeers.map(checkArweavePeer)
]);

console.table(results);
for (const type of ['solana-rpc', 'bundle-index', 'arweave-peer']) {
  if (!results.some((result) => result.type === type && result.ok)) {
    console.error(`${type}: 没有可用端点`);
    process.exitCode = 1;
  }
}
