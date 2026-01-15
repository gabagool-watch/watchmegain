/**
 * Low-latency HTTP keep-alive for Node's global fetch (undici).
 *
 * This reduces per-request overhead (TCP/TLS handshakes) when repeatedly calling the CLOB REST API
 * for order placement / cancels.
 *
 * Enabled via env:
 * - POLY_HTTP_KEEPALIVE=1
 */

export function enableHttpKeepAlive() {
  const enabled = (process.env.POLY_HTTP_KEEPALIVE || '').toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(enabled)) return;

  // Import lazily so this file doesn't crash in environments without undici import availability.
  // Node 18+ provides undici for global fetch.
  let undici: any;
  try {
    // eslint-disable-next-line
    undici = require('undici');
  } catch {
    // Optional optimization: if undici isn't installed, just skip keep-alive configuration.
    return;
  }

  const { Agent, setGlobalDispatcher } = undici ?? {};
  if (typeof Agent !== 'function' || typeof setGlobalDispatcher !== 'function') return;

  const connections = Number(process.env.POLY_HTTP_KEEPALIVE_CONNECTIONS || 50);

  setGlobalDispatcher(
    new Agent({
      connections: Number.isFinite(connections) ? connections : 50,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 300_000,
    })
  );
}

