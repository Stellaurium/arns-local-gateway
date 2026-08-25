const ARNS_PART = /^[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?$/;

export function validateArnsName(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split('_');
  if (parts.some((part) => !ARNS_PART.test(part) || part.length === 43)) return false;
  return parts.join('_').length <= 255;
}

function extractFromUrl(value, gatewayHosts) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const matchingGateway = gatewayHosts.find((gateway) => hostname.endsWith(`.${gateway}`));
  const name = matchingGateway
    ? hostname.slice(0, -(matchingGateway.length + 1))
    : hostname.endsWith('.ar')
      ? hostname.slice(0, -3)
      : hostname.split('.')[0];
  return { name, path: `${url.pathname}${url.search}${url.hash}` || '/' };
}

export function normalizeArnsInput(input, gatewayHosts = []) {
  let raw = String(input ?? '').trim().toLowerCase();
  if (!raw) throw new Error('请输入 ArNS 名称或地址');

  let parsed;
  if (raw.startsWith('ar://')) {
    const withoutScheme = raw.slice(5);
    const slash = withoutScheme.indexOf('/');
    parsed = slash === -1
      ? { name: withoutScheme, path: '/' }
      : { name: withoutScheme.slice(0, slash), path: `/${withoutScheme.slice(slash + 1)}` };
  } else if (/^https?:\/\//.test(raw)) {
    parsed = extractFromUrl(raw, gatewayHosts);
  } else {
    const slash = raw.indexOf('/');
    const hostPart = slash === -1 ? raw : raw.slice(0, slash);
    const requestPath = slash === -1 ? '/' : raw.slice(slash);
    const matchingGateway = gatewayHosts.find((gateway) => hostPart.endsWith(`.${gateway}`));
    let name = matchingGateway ? hostPart.slice(0, -(matchingGateway.length + 1)) : hostPart;
    if (name.endsWith('.ar')) name = name.slice(0, -3);
    parsed = { name, path: requestPath };
  }

  if (!validateArnsName(parsed.name)) {
    throw new Error('ArNS 名称格式无效；仅支持小写字母、数字、连字符和 undername 下划线');
  }

  if (!parsed.path.startsWith('/')) parsed.path = `/${parsed.path}`;
  return parsed;
}

export function extractArnsFromHost(hostHeader, localRootHost) {
  const hostname = String(hostHeader ?? '').split(':')[0].toLowerCase();
  if (hostname === localRootHost) return null;
  const suffix = `.${localRootHost}`;
  if (!hostname.endsWith(suffix)) return null;
  const name = hostname.slice(0, -suffix.length);
  return validateArnsName(name) ? name : null;
}
