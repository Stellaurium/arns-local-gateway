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

async function checkSolana(url, method, params) {
  const startedAt = performance.now();
  const safeUrl = new URL(url).origin;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8_000), redirect: 'error'
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const ok = response.ok && payload?.jsonrpc === '2.0' && Object.hasOwn(payload, 'result');
    return { type: 'solana-rpc', url: safeUrl, method, ok, status: response.status,
      durationMs: Math.round(performance.now() - startedAt), detail: ok ? 'supported' : `HTTP ${response.status}; RPC ${payload?.error?.code ?? 'invalid response'}` };
  } catch (error) {
    return { type: 'solana-rpc', url: safeUrl, method, ok: false, detail: error.name };
  }
}

async function checkSolanaCapabilities(url) {
  // A program with no application-owned accounts keeps this capability probe small.
  const checks = [
    ['getSlot', []],
    ['getAccountInfo', ['11111111111111111111111111111111', { encoding: 'base64' }]],
    ['getProgramAccounts', ['ComputeBudget111111111111111111111111111111', { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]]
  ];
  const results = [];
  for (const [method, params] of checks) results.push(await checkSolana(url, method, params));
  return results;
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

const results = (await Promise.all([
  ...config.solanaRpcUrls.map(checkSolanaCapabilities),
  ...config.bundleIndexUrls.map(checkBundleIndex),
  ...config.arweavePeers.map(checkArweavePeer)
])).flat();

console.table(results);
for (const type of ['solana-rpc', 'bundle-index', 'arweave-peer']) {
  if (!results.some((result) => result.type === type && result.ok)) {
    console.error(`${type}: 没有可用端点`);
    process.exitCode = 1;
  }
}
for (const method of ['getAccountInfo', 'getProgramAccounts']) {
  if (!results.some(result => result.type === 'solana-rpc' && result.method === method && result.ok)) {
    console.error(`${method}: 没有确认支持此查询的 RPC；基本在线不代表支持账户或索引查询`);
    process.exitCode = 1;
  }
}
