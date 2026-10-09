import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';

const decoders = new Map([
  ['gzip', promisify(gunzip)], ['x-gzip', promisify(gunzip)],
  ['deflate', promisify(inflate)], ['br', promisify(brotliDecompress)]
]);

// Decode for routing/serving only; never replace the immutable stored bytes.
export async function decodeStoredContent(result, maxOutputBytes) {
  const headers = result.metadata.headers ?? {};
  const encoding = headers['content-encoding'] ?? result.metadata.tags?.find(tag => tag.name.toLowerCase() === 'content-encoding')?.value;
  if (!encoding || encoding.trim().toLowerCase() === 'identity') return result;
  let body = result.body;
  for (const name of encoding.toLowerCase().split(',').map(value => value.trim()).reverse()) {
    if (name === 'identity') continue;
    const decode = decoders.get(name);
    if (!decode) throw new Error(`Unsupported stored content encoding: ${name}`);
    body = await decode(body, { maxOutputLength: maxOutputBytes });
  }
  const decodedHeaders = { ...headers, 'content-length': String(body.length) };
  delete decodedHeaders['content-encoding'];
  delete decodedHeaders['content-digest'];
  delete decodedHeaders.etag;
  return { ...result, body, metadata: { ...result.metadata, headers: decodedHeaders } };
}
