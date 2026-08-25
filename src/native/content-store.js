import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_ID = /^[A-Za-z0-9_-]{43}$/;

function filesFor(directory, id) {
  return {
    body: path.join(directory, 'objects', `${id}.body`),
    metadata: path.join(directory, 'objects', `${id}.json`)
  };
}

function safeHeaders(headers) {
  const names = [
    'content-type', 'content-length', 'content-digest', 'etag',
    'x-ar-io-data-id', 'x-ar-io-digest', 'x-ar-io-verified',
    'x-arweave-owner-address', 'x-arweave-signature-type'
  ];
  return Object.fromEntries(names.map((name) => [name, headers.get(name)]).filter(([, value]) => value !== null));
}

function verifyContentDigest(body, digestHeader) {
  if (!digestHeader) return { checked: false, valid: null };
  const match = digestHeader.match(/^sha-256=:([^:]+):$/i);
  if (!match) return { checked: false, valid: null };
  const actual = crypto.createHash('sha256').update(body).digest('base64');
  return { checked: true, valid: actual === match[1], algorithm: 'sha-256', actual };
}

export class ImmutableContentStore {
  constructor({ directory, providerUrls, timeoutMs, maxResponseBytes, bundleSource = null, logger = console }) {
    this.directory = directory;
    this.providerUrls = providerUrls;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.bundleSource = bundleSource;
    this.logger = logger;
  }

  async getLocal(id) {
    if (!DATA_ID.test(id)) throw new Error(`Invalid Arweave data ID: ${id}`);
    const files = filesFor(this.directory, id);
    try {
      const [body, metadataText] = await Promise.all([
        fs.readFile(files.body),
        fs.readFile(files.metadata, 'utf8')
      ]);
      return { body, metadata: JSON.parse(metadataText), source: 'immutable-store' };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async put(id, body, metadata) {
    const files = filesFor(this.directory, id);
    await fs.mkdir(path.dirname(files.body), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}.tmp`;
    const bodyTemp = `${files.body}.${suffix}`;
    const metadataTemp = `${files.metadata}.${suffix}`;
    await Promise.all([
      fs.writeFile(bodyTemp, body),
      fs.writeFile(metadataTemp, JSON.stringify(metadata, null, 2))
    ]);
    await Promise.all([fs.rename(bodyTemp, files.body), fs.rename(metadataTemp, files.metadata)]);
  }

  async fetchProvider(id, template) {
    const url = template.replaceAll('{id}', id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
      if (declaredLength > this.maxResponseBytes) throw new Error(`Response exceeds ${this.maxResponseBytes} bytes`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > this.maxResponseBytes) throw new Error(`Response exceeds ${this.maxResponseBytes} bytes`);
      const claimedId = response.headers.get('x-ar-io-data-id');
      if (claimedId && claimedId !== id) throw new Error(`Provider returned data ID ${claimedId}`);
      const headers = safeHeaders(response.headers);
      const digest = verifyContentDigest(body, headers['content-digest']);
      if (digest.checked && !digest.valid) throw new Error('Content-Digest verification failed');
      return {
        body,
        metadata: {
          id,
          providerUrl: url,
          fetchedAt: Date.now(),
          headers,
          digest
        },
        source: 'data-provider'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async get(id) {
    const local = await this.getLocal(id);
    if (local) return local;
    const errors = [];
    if (this.bundleSource) {
      try {
        const result = await this.bundleSource.get(id);
        await this.put(id, result.body, result.metadata);
        this.logger.info(`Stored immutable data ${id} (${result.body.length} bytes) from Arweave chunks`);
        return result;
      } catch (error) {
        errors.push(`bundle-peer: ${error.message}`);
      }
    }
    for (const template of this.providerUrls) {
      try {
        const result = await this.fetchProvider(id, template);
        await this.put(id, result.body, result.metadata);
        this.logger.info(`Stored immutable data ${id} (${result.body.length} bytes)`);
        return result;
      } catch (error) {
        errors.push(`${template}: ${error.message}`);
      }
    }
    throw new Error(`Unable to retrieve immutable data ${id}: ${errors.join('; ')}`);
  }
}

export function isDataId(value) {
  return DATA_ID.test(value);
}
