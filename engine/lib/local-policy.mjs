// This build has no cloud mode. Literal loopback addresses avoid DNS rebinding.
export function localURL(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('本机模式：服务地址无效'); }
  if (!['http:', 'https:'].includes(u.protocol) ||
      !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password) {
    throw new Error('本机模式：已阻止外部服务地址，请配置 127.0.0.1 或 [::1]');
  }
  return u;
}
const nativeFetch = globalThis.fetch;
export function localFetch(input, init = {}) {
  localURL(input instanceof Request ? input.url : input);
  return nativeFetch(input, { ...init, redirect: 'error' });
}
// Covers provider probes, fallbacks and accidental future fetch callsites.
globalThis.fetch = localFetch;
