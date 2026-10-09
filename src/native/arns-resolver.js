import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARIO, ANT } from '@ar.io/sdk';
import { createSolanaRpcFromTransport } from '@solana/kit';
import { SolanaRpcPool } from './solana-rpc-pool.js';

function splitArnsName(name) {
  const separator = name.indexOf('_');
  if (separator === -1) return { baseName: name, undername: '@' };
  return {
    undername: name.slice(0, separator),
    baseName: name.slice(separator + 1)
  };
}

function resolutionFile(directory, name) {
  return path.join(directory, 'resolutions', `${name}.json`);
}

export class NativeArnsResolver {
  constructor({ rpcUrls, rpcPool = null, dataDirectory, retryBackoffMs = 30_000, logger = console }) {
    this.rpcUrls = rpcUrls;
    this.dataDirectory = dataDirectory;
    this.logger = logger;
    this.retryBackoffMs = retryBackoffMs;
    this.retryAfter = new Map();
    this.rpcPool = rpcPool ?? new SolanaRpcPool({ urls: rpcUrls, directory: dataDirectory, logger });
    this.pending = new Map();
  }

  async readCached(name) {
    try {
      const cached = JSON.parse(await fs.readFile(resolutionFile(this.dataDirectory, name), 'utf8'));
      const ageSeconds = Math.max(0, (Date.now() - cached.resolvedAt) / 1000);
      if (cached.rpcUrl) cached.rpcUrl = new URL(cached.rpcUrl).origin;
      return { ...cached, ageSeconds, fresh: ageSeconds < cached.ttlSeconds };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async writeCached(name, resolution) {
    const directory = path.join(this.dataDirectory, 'resolutions');
    await fs.mkdir(directory, { recursive: true });
    const target = resolutionFile(this.dataDirectory, name);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(resolution, null, 2));
    await fs.rename(temporary, target);
  }

  async resolve(name, { force = false } = {}) {
    const key = `${name}:${force}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.resolveUnshared(name, { force }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  async resolveUnshared(name, { force = false } = {}) {
    const cached = await this.readCached(name);
    if (!force && cached?.fresh) return { ...cached, source: 'resolution-cache' };
    if (!force && cached && (this.retryAfter.get(name) ?? 0) > Date.now()) {
      return { ...cached, source: 'resolution-cache-stale' };
    }

    const errors = [];
    const { baseName, undername } = splitArnsName(name);
    try {
      const rpc = createSolanaRpcFromTransport(async ({ payload }) => ({
        jsonrpc: '2.0', id: payload.id,
        result: await this.rpcPool.call(payload.method, payload.params, { force })
      }));
      const ario = ARIO.init({ rpc });
      const nameRecord = await ario.getArNSRecord({ name: baseName });
      const ant = await ANT.init({ processId: nameRecord.processId, rpc });
      const antRecord = await ant.getRecord({ undername });
      if (!antRecord) throw new Error(`ANT record ${undername} was not found`);
      const resolution = {
        name,
        baseName,
        undername,
        targetId: antRecord.transactionId,
        targetProtocol: antRecord.targetProtocol ?? 0,
        processId: nameRecord.processId,
        ttlSeconds: Math.max(1, antRecord.ttlSeconds),
        priority: antRecord.priority,
        resolvedAt: Date.now(),
        rpcUrl: this.rpcPool.lastEndpoint ? new URL(this.rpcPool.lastEndpoint).origin : null
      };
      await this.writeCached(name, resolution);
      this.retryAfter.delete(name);
      return { ...resolution, source: 'solana-rpc' };
    } catch (error) {
      if (/^ArNS record not found:|^ANT record .* was not found$/.test(error.message)) {
        error.code = 'ARNS_NOT_FOUND';
        throw error;
      }
      errors.push({ error: error.message });
    }

    if (cached) {
      this.retryAfter.set(name, Date.now() + this.retryBackoffMs);
      this.logger.warn(`ArNS ${name}: all RPCs failed; using stale resolution`);
      return { ...cached, source: 'resolution-cache-stale', errors };
    }
    throw new Error(`ArNS resolution failed: ${errors.map((item) => item.error).join('; ')}`);
  }
}
