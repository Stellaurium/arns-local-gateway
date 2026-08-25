import { isDataId } from './content-store.js';

export function parseManifest(body, contentType = '') {
  if (!contentType.includes('arweave-manifest') && body[0] !== 0x7b) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed?.manifest !== 'arweave/paths' || typeof parsed.paths !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://local.invalid').pathname);
  const parts = pathname.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Unsafe manifest path');
  return parts.join('/');
}

export function resolveManifestPath(manifest, requestUrl) {
  let requested = cleanPath(requestUrl);
  if (!requested) requested = manifest.index?.path ?? 'index.html';

  const candidates = [requested];
  if (requested.endsWith('/')) candidates.push(`${requested}index.html`);
  else candidates.push(`${requested}/index.html`);

  for (const candidate of candidates) {
    const id = manifest.paths?.[candidate]?.id;
    if (isDataId(id)) return { id, path: candidate, resolutionType: 'path' };
  }

  const fallbackId = manifest.fallback?.id;
  if (isDataId(fallbackId)) return { id: fallbackId, path: requested, resolutionType: 'fallback' };
  return null;
}

export function manifestDataIds(manifest) {
  const ids = new Set();
  for (const item of Object.values(manifest.paths ?? {})) {
    if (isDataId(item?.id)) ids.add(item.id);
  }
  if (isDataId(manifest.fallback?.id)) ids.add(manifest.fallback.id);
  return [...ids];
}
