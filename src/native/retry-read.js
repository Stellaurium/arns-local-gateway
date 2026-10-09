import { setTimeout as delay } from 'node:timers/promises';

export function isTransientReadError(error) {
  const code = error.cause?.code ?? error.code ?? '';
  if (/CERT|TLS_CERT|SELF_SIGNED|VERIFY_LEAF/.test(code)) return false;
  return ['AbortError', 'TimeoutError'].includes(error.name) ||
    (error instanceof TypeError && /fetch failed|terminated/.test(error.message)) ||
    /^(ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code) ||
    (error.status >= 500 && error.status <= 599 && error.status !== 501);
}

// Only idempotent reads use this helper; never retry denied/absent data or writes.
export async function retryTransientRead(operation) {
  try { return await operation(); }
  catch (error) {
    if (!isTransientReadError(error)) throw error;
    await delay(200);
    return operation();
  }
}
