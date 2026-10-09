import crypto from 'node:crypto';
import { retryTransientRead } from './retry-read.js';

const SIGNATURES = new Map([
  [1, { signatureLength: 512, ownerLength: 512 }],
  [2, { signatureLength: 64, ownerLength: 32 }],
  [3, { signatureLength: 65, ownerLength: 65 }],
  [4, { signatureLength: 64, ownerLength: 32 }]
]);

function readUnsignedLong(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  for (;;) {
    if (cursor >= buffer.length) throw new Error('Invalid Avro tag data');
    const byte = BigInt(buffer[cursor++]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) break;
    shift += 7n;
    if (shift > 63n) throw new Error('Avro integer is too large');
  }
  return { value: (value >> 1n) ^ (-(value & 1n)), offset: cursor };
}

function readAvroString(buffer, offset) {
  const lengthResult = readUnsignedLong(buffer, offset);
  const length = Number(lengthResult.value);
  if (length < 0 || lengthResult.offset + length > buffer.length) throw new Error('Invalid Avro string');
  return {
    value: buffer.subarray(lengthResult.offset, lengthResult.offset + length).toString('utf8'),
    offset: lengthResult.offset + length
  };
}

export function decodeDataItemTags(buffer) {
  const tags = [];
  let cursor = 0;
  for (;;) {
    let block = readUnsignedLong(buffer, cursor);
    let count = block.value;
    cursor = block.offset;
    if (count === 0n) break;
    if (count < 0n) {
      count = -count;
      block = readUnsignedLong(buffer, cursor);
      cursor = block.offset;
    }
    for (let index = 0n; index < count; index += 1n) {
      const name = readAvroString(buffer, cursor);
      const value = readAvroString(buffer, name.offset);
      cursor = value.offset;
      tags.push({ name: name.value, value: value.value });
    }
  }
  return tags;
}

export function extractDataItem(item, expectedId) {
  const signatureType = item.readUInt16LE(0);
  const configuration = SIGNATURES.get(signatureType);
  if (!configuration) throw new Error(`Unsupported ANS-104 signature type ${signatureType}`);
  const signatureStart = 2;
  const signatureEnd = signatureStart + configuration.signatureLength;
  const actualId = crypto.createHash('sha256').update(item.subarray(signatureStart, signatureEnd)).digest('base64url');
  if (actualId !== expectedId) throw new Error(`Bundle item ID mismatch: expected ${expectedId}, received ${actualId}`);

  let cursor = signatureEnd + configuration.ownerLength;
  const hasTarget = item[cursor++];
  if (hasTarget === 1) cursor += 32;
  else if (hasTarget !== 0) throw new Error('Invalid ANS-104 target flag');
  const hasAnchor = item[cursor++];
  if (hasAnchor === 1) cursor += 32;
  else if (hasAnchor !== 0) throw new Error('Invalid ANS-104 anchor flag');

  const tagCount = Number(item.readBigUInt64LE(cursor));
  cursor += 8;
  const tagBytesLength = Number(item.readBigUInt64LE(cursor));
  cursor += 8;
  if (cursor + tagBytesLength > item.length) throw new Error('ANS-104 tag section exceeds item size');
  const tags = decodeDataItemTags(item.subarray(cursor, cursor + tagBytesLength));
  if (tags.length !== tagCount) throw new Error('ANS-104 tag count mismatch');
  cursor += tagBytesLength;
  return { body: item.subarray(cursor), tags, signatureType };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options?.signal) signals.push(options.signal);
  // Keep the timeout attached while the response body is being consumed.
  return fetchImpl(url, { ...options, signal: AbortSignal.any(signals) });
}

export class BundlePeerSource {
  constructor({ indexUrls, peers = [], peerPool = null, timeoutMs, maxResponseBytes, fetchImpl = fetch, peerRequestConcurrency = 8, peerCandidateLimit = 64 }) {
    this.indexUrls = indexUrls;
    this.peerPool = peerPool ?? {
      async candidates() { return peers; },
      recordSuccess() {},
      recordFailure() {},
      async discover() { return []; },
      async discoverLayer() { return []; },
      maxDepth: 0
    };
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.fetchImpl = fetchImpl;
    this.peerRequestConcurrency = peerRequestConcurrency;
    this.peerCandidateLimit = peerCandidateLimit;
    this.bundleIndexes = new Map();
    this.transactionLayouts = new Map();
  }

  async findParent(id) {
    const errors = [];
    const query = 'query($ids:[ID!]){transactions(ids:$ids){edges{node{id bundledIn{id} data{size type} tags{name value}}}}}';
    for (const url of this.indexUrls) {
      try {
        return await retryTransientRead(async () => {
        const response = await fetchWithTimeout(this.fetchImpl, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: { ids: [id] } })
        }, this.timeoutMs);
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        const payload = await response.json();
        const node = payload?.data?.transactions?.edges?.[0]?.node;
        if (!node) throw new Error('Data item was not found');
        return {
          parentId: node.bundledIn?.id ?? null,
          dataSize: Number(node.data?.size ?? 0),
          contentType: node.data?.type ?? null,
          contentEncoding: node.tags?.find(tag => tag.name.toLowerCase() === 'content-encoding')?.value ?? null,
          indexUrl: url
        };
        });
      } catch (error) {
        errors.push(`${url}: ${error.message}`);
      }
    }
    throw new Error(`Bundle index lookup failed: ${errors.join('; ')}`);
  }

  async fetchChunkFromPeer(peer, absoluteOffset, signal) {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(this.fetchImpl, `${peer}/chunk/${absoluteOffset}`, { signal }, this.timeoutMs);
    if (!response.ok) throw new Error(`chunk HTTP ${response.status}`);
    const payload = await response.json();
    if (typeof payload?.chunk !== 'string' || payload.absolute_end_offset === undefined) throw new Error('Invalid chunk response');
    const body = Buffer.from(payload.chunk, 'base64url');
    const end = BigInt(payload.absolute_end_offset);
    const result = { body, start: end - BigInt(body.length) + 1n, end, peer };
    if (BigInt(absoluteOffset) < result.start || BigInt(absoluteOffset) > result.end) throw new Error('Peer returned a chunk outside the requested offset');
    this.peerPool.recordSuccess(peer, Date.now() - startedAt);
    return result;
  }

  async tryPeerBatches(peers, operation) {
    const errors = [];
    for (let cursor = 0; cursor < peers.length; cursor += this.peerRequestConcurrency) {
      const batch = peers.slice(cursor, cursor + this.peerRequestConcurrency);
      const controller = new AbortController();
      const failures = [];
      try {
        const value = await Promise.any(batch.map(async (peer) => {
        try {
          return await operation(peer, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) {
            this.peerPool.recordFailure(peer);
            failures.push(`${peer}: ${error.message}`);
          }
          throw error;
        }
        }));
        controller.abort();
        return { value, errors };
      } catch {
        controller.abort();
        errors.push(...failures);
      }
    }
    return { value: null, errors };
  }

  async withPeerFailover(operation, label, discoveryRoots = []) {
    const initialPeers = await this.peerPool.candidates({ limit: this.peerCandidateLimit });
    const attempted = new Set(initialPeers);
    let result = await this.tryPeerBatches(initialPeers, operation);
    if (result.value) return result.value;
    const errors = [...result.errors];
    let frontier = [...new Set([...discoveryRoots, ...initialPeers.slice(0, this.peerRequestConcurrency)])];
    for (let depth = 0; depth < (this.peerPool.maxDepth ?? 0); depth += 1) {
      const discovered = await this.peerPool.discoverLayer(frontier);
      const expandedPeers = discovered.filter((peer) => !attempted.has(peer));
      for (const peer of expandedPeers) attempted.add(peer);
      if (!expandedPeers.length) break;
      result = await this.tryPeerBatches(expandedPeers, operation);
      if (result.value) return result.value;
      errors.push(...result.errors);
      frontier = expandedPeers;
    }
    throw new Error(`${label} failed: ${errors.join('; ')}`);
  }

  async fetchChunk(absoluteOffset, discoveryRoots = []) {
    return this.withPeerFailover(
      (peer, signal) => this.fetchChunkFromPeer(peer, absoluteOffset, signal),
      `Chunk ${absoluteOffset}`,
      discoveryRoots
    );
  }

  async readRange(start, length, peersUsed = new Set()) {
    if (length > this.maxResponseBytes) throw new Error(`Requested range exceeds ${this.maxResponseBytes} bytes`);
    const end = start + BigInt(length) - 1n;
    const result = Buffer.alloc(length);
    let cursor = start;
    while (cursor <= end) {
      const chunk = await this.fetchChunk(cursor, [...peersUsed]);
      peersUsed.add(chunk.peer);
      const copyStart = chunk.start > start ? chunk.start : start;
      const copyEnd = chunk.end < end ? chunk.end : end;
      if (copyStart > copyEnd || chunk.end < cursor) throw new Error('Arweave peer returned the wrong chunk');
      chunk.body.copy(result, Number(copyStart - start), Number(copyStart - chunk.start), Number(copyEnd - chunk.start + 1n));
      cursor = chunk.end + 1n;
    }
    return result;
  }

  async getTransactionLayout(transactionId) {
    if (this.transactionLayouts.has(transactionId)) return this.transactionLayouts.get(transactionId);
    const layout = await this.withPeerFailover(async (peer, signal) => {
      const startedAt = Date.now();
      const response = await fetchWithTimeout(this.fetchImpl, `${peer}/tx/${transactionId}/offset`, { signal }, this.timeoutMs);
      if (!response.ok) throw new Error(`transaction offset HTTP ${response.status}`);
      const transaction = await response.json();
      const size = BigInt(transaction.size);
      const end = BigInt(transaction.offset);
      if (size < 0n || end < size - 1n) throw new Error('Invalid transaction offset response');
      this.peerPool.recordSuccess(peer, Date.now() - startedAt);
      return { size, end, start: end - size + 1n, offsetPeer: peer };
    }, `Transaction offset ${transactionId}`);
    this.transactionLayouts.set(transactionId, layout);
    return layout;
  }

  async loadBundleIndex(parentId, peersUsed = new Set()) {
    if (this.bundleIndexes.has(parentId)) return this.bundleIndexes.get(parentId);
    const { size, start, offsetPeer } = await this.getTransactionLayout(parentId);
    peersUsed.add(offsetPeer);
    const prefix = await this.readRange(start, 32, peersUsed);
    const count = Number(prefix.readBigUInt64LE(0));
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error(`Invalid bundle item count ${count}`);
    const headerLength = 32 + count * 64;
    const header = await this.readRange(start, headerLength, peersUsed);
    const entries = new Map();
    let cumulativeSize = 0n;
    for (let index = 0; index < count; index += 1) {
      const cursor = 32 + index * 64;
      const itemSize = header.readBigUInt64LE(cursor);
      const id = header.subarray(cursor + 32, cursor + 64).toString('base64url');
      entries.set(id, { size: itemSize, start: start + BigInt(headerLength) + cumulativeSize });
      cumulativeSize += itemSize;
    }
    if (BigInt(headerLength) + cumulativeSize !== size) throw new Error('Bundle index sizes do not match transaction size');
    const result = { entries, start, size };
    this.bundleIndexes.set(parentId, result);
    return result;
  }

  async getBundledItem(id, parent) {
    const peersUsed = new Set();
    const index = await this.loadBundleIndex(parent.parentId, peersUsed);
    const entry = index.entries.get(id);
    if (!entry) throw new Error(`Bundle ${parent.parentId} does not contain ${id}`);
    if (entry.size > BigInt(this.maxResponseBytes)) throw new Error('Bundled data item exceeds configured maximum');
    const item = await this.readRange(entry.start, Number(entry.size), peersUsed);
    const parsed = extractDataItem(item, id);
    if (parent.dataSize && parsed.body.length !== parent.dataSize) throw new Error('Indexed data size does not match extracted data');
    const contentType = parsed.tags.find((tag) => tag.name.toLowerCase() === 'content-type')?.value;
    const contentEncoding = parsed.tags.find((tag) => tag.name.toLowerCase() === 'content-encoding')?.value;
    return {
      body: parsed.body,
      metadata: {
        id,
        fetchedAt: Date.now(),
        parentBundleId: parent.parentId,
        indexUrl: parent.indexUrl,
        arweavePeer: [...peersUsed].at(-1),
        arweavePeers: [...peersUsed],
        signatureType: parsed.signatureType,
        idVerifiedFromSignature: true,
        tags: parsed.tags,
        headers: {
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(contentEncoding ? { 'content-encoding': contentEncoding } : {}),
          'content-length': String(parsed.body.length)
        }
      },
      source: 'arweave-peer-chunks'
    };
  }

  async getDirectTransaction(id, indexed) {
    const peersUsed = new Set();
    const layout = await this.getTransactionLayout(id);
    peersUsed.add(layout.offsetPeer);
    if (layout.size > BigInt(this.maxResponseBytes)) throw new Error('Transaction data exceeds configured maximum');
    if (indexed.dataSize && layout.size !== BigInt(indexed.dataSize)) throw new Error('Indexed data size does not match transaction size');
    const body = await this.readRange(layout.start, Number(layout.size), peersUsed);
    return {
      body,
      metadata: {
        id,
        fetchedAt: Date.now(),
        indexUrl: indexed.indexUrl,
        arweavePeer: [...peersUsed].at(-1),
        arweavePeers: [...peersUsed],
        directL1Transaction: true,
        headers: {
          ...(indexed.contentType ? { 'content-type': indexed.contentType } : {}),
          ...(indexed.contentEncoding ? { 'content-encoding': indexed.contentEncoding } : {}),
          'content-length': String(body.length)
        }
      },
      source: 'arweave-peer-chunks'
    };
  }

  async get(id) {
    const indexed = await this.findParent(id);
    return indexed.parentId ? this.getBundledItem(id, indexed) : this.getDirectTransaction(id, indexed);
  }
}
