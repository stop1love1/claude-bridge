/**
 * Header the bridge's own HTTP server (`scripts/bridge-http-server.ts`)
 * stamps with the TCP connection's real remote address, so `proxy.ts`
 * — which runs as Next middleware and has no access to `req.socket` —
 * can tell a same-host request from one that transited a proxy/tunnel.
 *
 * This header is SERVER-authored only: every reader must delete any
 * inbound copy before trusting it (see the `createServer` callback in
 * `scripts/bridge-http-server.ts`). Skipping that delete would just be
 * the old `Host`-header spoof under a new name — a remote client could
 * set this header itself and forge "same host" (audit H2). Defined
 * once here so `proxy.ts` and `bridge-http-server.ts` can't drift on
 * the literal.
 */
export const PEER_ADDR_HEADER = "x-bridge-peer-addr";

/**
 * Normalize an IPv4-mapped IPv6 address (`::ffff:127.0.0.1` — the form
 * Node reports for an IPv4 connection when the server also binds the
 * IPv6 stack) down to plain IPv4, so a loopback comparison doesn't
 * miss a same-host connection just because it arrived over the v6
 * socket family.
 */
export function normalizePeerAddr(addr: string): string {
  return addr.replace(/^::ffff:/i, "");
}
