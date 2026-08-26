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
 * Header the HTTP server stamps with the CLIENT's own `x-forwarded-for`
 * value, captured BEFORE Next.js can touch it — never the (possibly
 * Next-mutated) `x-forwarded-for` header itself.
 *
 * Next's `base-server.js` unconditionally runs
 * `req.headers['x-forwarded-for'] ??= req.socket.remoteAddress` on
 * EVERY request that reaches it, including a direct same-host call
 * with no real proxy anywhere in the picture (confirmed against
 * Next 16.2.4 and 16.3.3 — same line, `:576` and `:612`
 * respectively). By the time `proxy.ts` runs, a bare `x-forwarded-for`
 * check can therefore never distinguish "a real proxy forwarded this"
 * from "Next filled this in itself" — the raw header is present on
 * 100% of requests, so treating its mere presence as a proxy signal
 * permanently kills the same-host bypass for every legitimate local
 * caller (this is the same trap the code already documents for
 * `x-forwarded-host`, just on a header nobody had checked yet). We
 * snapshot the header exactly as it arrived on the wire — before
 * Next's default-fill has a chance to run — and `proxy.ts` reads
 * THAT, so an absent client header still reads as absent even though
 * Next later synthesizes one.
 *
 * Same rule as `PEER_ADDR_HEADER`: server-authored, so any inbound
 * copy must be deleted before stamping.
 */
export const CLIENT_FORWARDED_FOR_HEADER = "x-bridge-client-xff";

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
