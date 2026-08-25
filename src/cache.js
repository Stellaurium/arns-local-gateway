import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class DiskCache {
  constructor(directory, defaultTtlSeconds) {
    this.directory = directory;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  filesFor(key) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return {
      body: path.join(this.directory, `${hash}.body`),
      metadata: path.join(this.directory, `${hash}.json`)
    };
  }

  async get(key) {
    const files = this.filesFor(key);
    try {
      const [metadataText, body] = await Promise.all([
        fs.readFile(files.metadata, 'utf8'),
        fs.readFile(files.body)
      ]);
      const metadata = JSON.parse(metadataText);
      const ageSeconds = Math.max(0, (Date.now() - metadata.cachedAt) / 1000);
      return {
        ...metadata,
        body,
        ageSeconds,
        fresh: ageSeconds <= (metadata.ttlSeconds ?? this.defaultTtlSeconds)
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async put(key, response) {
    await fs.mkdir(this.directory, { recursive: true });
    const files = this.filesFor(key);
    const suffix = `${process.pid}-${Date.now()}`;
    const bodyTemp = `${files.body}.${suffix}.tmp`;
    const metadataTemp = `${files.metadata}.${suffix}.tmp`;
    const metadata = {
      statusCode: response.statusCode,
      headers: response.headers,
      sourceGateway: response.sourceGateway,
      cachedAt: Date.now(),
      ttlSeconds: response.ttlSeconds
    };
    await Promise.all([
      fs.writeFile(bodyTemp, response.body),
      fs.writeFile(metadataTemp, JSON.stringify(metadata))
    ]);
    await Promise.all([
      fs.rename(bodyTemp, files.body),
      fs.rename(metadataTemp, files.metadata)
    ]);
  }
}

export function cacheTtlFromHeaders(headers, fallbackSeconds) {
  const cacheControl = String(headers['cache-control'] ?? '');
  const match = cacheControl.match(/(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/i);
  if (!match) return fallbackSeconds;
  return Math.max(1, Math.min(Number.parseInt(match[1], 10), fallbackSeconds));
}
