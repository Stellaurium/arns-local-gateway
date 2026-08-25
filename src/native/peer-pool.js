import fs from 'node:fs/promises';
import path from 'node:path';

function isPublicIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!value.includes(':')) return false;
  return value !== '::' && value !== '::1' && !value.startsWith('fc') && !value.startsWith('fd') && !value.startsWith('fe8') && !value.startsWith('fe9') && !value.startsWith('fea') && !value.startsWith('feb');
}

function isSafeTrustedHostname(hostname) {
  const value = hostname.toLowerCase();
  return value !== 'localhost' && !value.endsWith('.localhost') && !value.endsWith('.local') && /^[a-z0-9.-]+$/i.test(value);
}

export function normalizePeerUrl(value, { trusted = false } = {}) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalPublicAddress = isPublicIpv4(hostname) || isPublicIpv6(hostname);
  if (!literalPublicAddress && !(trusted && isSafeTrustedHostname(hostname))) return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '1984');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  const formattedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `${url.protocol}//${formattedHost}:${port}`;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function score(record, seedSet) {
  const seedBonus = seedSet.has(record.url) ? 100 : 0;
  const successBonus = Math.min(record.successes ?? 0, 20) * 8;
  const failurePenalty = Math.min(record.failures ?? 0, 20) * 5;
  const recentBonus = record.lastSuccessAt ? Math.max(0, 40 - (Date.now() - record.lastSuccessAt) / 3_600_000) : 0;
  const latencyPenalty = Math.min(record.latencyMs ?? 0, 10_000) / 1000;
  return seedBonus + successBonus + recentBonus - failurePenalty - latencyPenalty;
}

export class ArweavePeerPool {
  constructor({
    seeds,
    directory,
    timeoutMs,
    fetchImpl = fetch,
    discoveryEnabled = true,
    maxPeers = 512,
    maxDepth = 2,
    discoveryConcurrency = 8,
    refreshIntervalMs = 6 * 60 * 60 * 1000,
    logger = console
  }) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.discoveryEnabled = discoveryEnabled;
    this.maxPeers = maxPeers;
    this.maxDepth = maxDepth;
    this.discoveryConcurrency = discoveryConcurrency;
    this.refreshIntervalMs = refreshIntervalMs;
    this.logger = logger;
    this.file = path.join(directory, 'peer-pool.json');
    this.records = new Map();
    this.loaded = false;
    this.discoveryPromise = null;
    this.persistPromise = Promise.resolve();
    this.lastRefreshAt = 0;
    this.refreshTimer = null;
    this.seeds = [...new Set(seeds.map((peer) => normalizePeerUrl(peer, { trusted: true })).filter(Boolean))];
    this.seedSet = new Set(this.seeds);
    for (const url of this.seeds) this.records.set(url, { url, seed: true, successes: 0, failures: 0 });
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const payload = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.lastRefreshAt = Number(payload.lastFullRefreshAt ?? payload.updatedAt ?? 0);
      for (const entry of payload.peers ?? []) {
        const url = normalizePeerUrl(entry.url, { trusted: this.seedSet.has(entry.url) });
        if (!url || this.records.size >= this.maxPeers) continue;
        this.records.set(url, {
          url,
          seed: this.seedSet.has(url),
          successes: Number(entry.successes ?? 0),
          failures: Number(entry.failures ?? 0),
          latencyMs: Number(entry.latencyMs ?? 0),
          discoveredAt: Number(entry.discoveredAt ?? 0),
          lastSeenAt: Number(entry.lastSeenAt ?? 0),
          lastSuccessAt: Number(entry.lastSuccessAt ?? 0),
          lastFailureAt: Number(entry.lastFailureAt ?? 0)
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) this.logger.warn(`Unable to load peer pool: ${error.message}`);
    }
    for (const url of this.seeds) {
      if (!this.records.has(url)) this.records.set(url, { url, seed: true, successes: 0, failures: 0 });
    }
  }

  async persist({ fullRefresh = false } = {}) {
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      const peers = [...this.records.values()].slice(0, this.maxPeers);
      const updatedAt = Date.now();
      if (fullRefresh) this.lastRefreshAt = updatedAt;
      await fs.writeFile(temp, JSON.stringify({
        version: 1,
        updatedAt,
        lastFullRefreshAt: this.lastRefreshAt,
        peers
      }, null, 2));
      await fs.rename(temp, this.file);
    };
    const current = this.persistPromise.then(write);
    this.persistPromise = current.catch(() => {});
    return current;
  }

  async candidates({ limit = this.maxPeers } = {}) {
    await this.load();
    return [...this.records.values()]
      .sort((left, right) => score(right, this.seedSet) - score(left, this.seedSet))
      .slice(0, limit)
      .map((entry) => entry.url);
  }

  recordSuccess(peer, latencyMs = 0) {
    const record = this.records.get(peer) ?? { url: peer, successes: 0, failures: 0 };
    record.successes = (record.successes ?? 0) + 1;
    record.lastSuccessAt = Date.now();
    record.lastSeenAt = Date.now();
    if (latencyMs > 0) record.latencyMs = record.latencyMs ? Math.round((record.latencyMs * 3 + latencyMs) / 4) : latencyMs;
    this.records.set(peer, record);
  }

  recordFailure(peer) {
    const record = this.records.get(peer) ?? { url: peer, successes: 0, failures: 0 };
    record.failures = (record.failures ?? 0) + 1;
    record.lastFailureAt = Date.now();
    this.records.set(peer, record);
  }

  async fetchPeerList(peer) {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(this.fetchImpl, `${peer}/peers`, this.timeoutMs);
    if (!response.ok) throw new Error(`peers HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Invalid peer list response');
    this.recordSuccess(peer, Date.now() - startedAt);
    return payload.map((value) => normalizePeerUrl(value)).filter(Boolean);
  }

  async discover(startPeers = this.seeds, { prune = false } = {}) {
    if (!this.discoveryEnabled) return [];
    await this.load();
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = this.runDiscovery(startPeers, { prune }).finally(() => {
      this.discoveryPromise = null;
    });
    return this.discoveryPromise;
  }

  async discoverLayer(startPeers) {
    if (!this.discoveryEnabled) return [];
    await this.load();
    const roots = [...new Set(startPeers
      .map((value) => normalizePeerUrl(value, { trusted: this.seedSet.has(value) }))
      .filter(Boolean))]
      .slice(0, this.discoveryConcurrency);
    const mentioned = new Set();
    for (let cursor = 0; cursor < roots.length; cursor += this.discoveryConcurrency) {
      const batch = roots.slice(cursor, cursor + this.discoveryConcurrency);
      const results = await Promise.all(batch.map(async (peer) => {
        try {
          return await this.fetchPeerList(peer);
        } catch {
          this.recordFailure(peer);
          return [];
        }
      }));
      for (const peers of results) {
        for (const peer of peers) {
          mentioned.add(peer);
          if (!this.records.has(peer) && this.records.size < this.maxPeers) {
            this.records.set(peer, {
              url: peer,
              seed: false,
              successes: 0,
              failures: 0,
              discoveredAt: Date.now(),
              lastSeenAt: Date.now()
            });
          } else if (this.records.has(peer)) {
            this.records.get(peer).lastSeenAt = Date.now();
          }
        }
      }
    }
    await this.persist();
    return [...mentioned];
  }

  async refresh() {
    const previous = await this.candidates();
    return this.discover([...this.seeds, ...previous], { prune: true });
  }

  startPeriodicRefresh() {
    if (!this.discoveryEnabled || this.refreshTimer) return;
    const run = () => this.refresh().catch((error) => this.logger.warn(`Arweave peer refresh failed: ${error.message}`));
    void this.load().then(() => {
      if (!this.lastRefreshAt || Date.now() - this.lastRefreshAt >= this.refreshIntervalMs) void run();
    });
    this.refreshTimer = setInterval(run, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stopPeriodicRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async runDiscovery(startPeers, { prune }) {
    const queue = [];
    const visited = new Set();
    const seen = new Set(this.seeds);
    const responsive = new Set();
    for (const value of startPeers) {
      const peer = normalizePeerUrl(value, { trusted: this.seedSet.has(value) });
      if (peer) queue.push({ peer, depth: 0 });
    }
    const added = [];
    while (queue.length && visited.size < this.maxPeers) {
      const batch = [];
      while (queue.length && batch.length < this.discoveryConcurrency) {
        const next = queue.shift();
        if (visited.has(next.peer)) continue;
        visited.add(next.peer);
        batch.push(next);
      }
      if (!batch.length) continue;
      const results = await Promise.all(batch.map(async ({ peer, depth }) => {
        try {
          return { peer, depth, peers: await this.fetchPeerList(peer), ok: true };
        } catch (error) {
          this.recordFailure(peer);
          return { peer, depth, peers: [], ok: false };
        }
      }));
      for (const result of results) {
        if (result.ok) {
          responsive.add(result.peer);
          seen.add(result.peer);
        }
        for (const peer of result.peers) {
          seen.add(peer);
          if (!this.records.has(peer) && added.length < this.maxPeers) {
            this.records.set(peer, {
              url: peer,
              seed: false,
              successes: 0,
              failures: 0,
              discoveredAt: Date.now(),
              lastSeenAt: Date.now()
            });
            added.push(peer);
          } else if (this.records.has(peer)) {
            this.records.get(peer).lastSeenAt = Date.now();
          }
          if (result.depth < this.maxDepth && !visited.has(peer)) queue.push({ peer, depth: result.depth + 1 });
        }
      }
      if (visited.size === batch.length || visited.size % 32 < batch.length) await this.persist();
    }
    let removed = 0;
    if (prune && responsive.size > 0) {
      for (const peer of [...this.records.keys()]) {
        if (!seen.has(peer) && !this.seedSet.has(peer)) {
          this.records.delete(peer);
          removed += 1;
        }
      }
    }
    if (this.records.size > this.maxPeers) {
      const keep = new Set(
        [...this.records.values()]
          .sort((left, right) => score(right, this.seedSet) - score(left, this.seedSet))
          .slice(0, this.maxPeers)
          .map((entry) => entry.url)
      );
      for (const seed of this.seeds) keep.add(seed);
      for (const peer of [...this.records.keys()]) {
        if (!keep.has(peer)) this.records.delete(peer);
      }
    }
    await this.persist({ fullRefresh: prune });
    if (added.length || removed) this.logger.info(`Refreshed Arweave peers: +${added.length}, -${removed}; pool now contains ${this.records.size}`);
    return added;
  }
}
