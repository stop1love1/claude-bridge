import { constantTimeStringEqual } from "./auth";
import { normalizePeerAddr } from "./peerAddr";

export interface InternalTokenGateInput {
  /** `PEER_ADDR_HEADER` value — the TCP peer, stamped server-side. */
  peerAddr: string | null;
  /**
   * `CLIENT_FORWARDED_FOR_HEADER` value — the client's OWN
   * `x-forwarded-for`, captured by the HTTP server before Next's
   * base-server can default-fill the real header from the socket.
   * Never pass the raw `x-forwarded-for` header here (see
   * `libs/peerAddr.ts`'s header comment on why that always trips).
   */
  clientForwardedFor: string | null;
  xRealIp: string | null;
  forwarded: string | null;
  /**
   * Raw `Host` header off the request. Client-supplied and therefore
   * NOT trusted on its own (that was H2) — used only as an ADDITIONAL
   * restriction alongside the peer/forwarding signals, never as a
   * substitute for them. See the header comment above `isExpectedLocalHost`
   * for why this term exists despite that history.
   */
  hostHeader: string | null;
  /**
   * The `BRIDGE_HOST` env value the server is configured with, if any
   * — pass `process.env.BRIDGE_HOST ?? null` unmodified. A legitimate
   * child callback may target this literal instead of `localhost` /
   * `127.0.0.1`: `agents/permission-hook.cjs` connects to
   * `process.env.BRIDGE_HOST ?? "127.0.0.1"`, and that env var is
   * inherited by every spawned child (`libs/spawn.ts`), so it will
   * show up verbatim in the child's `Host` header too. Comparison is
   * case-insensitive; the port is stripped before comparing either
   * side.
   */
  expectedBridgeHost: string | null;
  internalToken: string | null;
  configuredInternalToken: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** Strip the port and IPv6 brackets from a `Host` header, lower-cased. */
function hostnameOf(hostHeader: string): string {
  const lower = hostHeader.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(1, end);
  }
  return lower.split(":")[0] ?? "";
}

/**
 * True when `hostHeader` names a host the bridge itself expects direct
 * local traffic to arrive as — the loopback literals, or the
 * configured `BRIDGE_HOST` (see that field's doc comment).
 *
 * This exists to close a gap the peer-address signal alone cannot:
 * `libs/tunnels.ts` spawns `localtunnel`/`ngrok` on the SAME machine
 * as the bridge, connecting to the local port. Every request arriving
 * through the operator's public tunnel therefore has a LOOPBACK TCP
 * peer — the peer signal contributes nothing for that topology, and
 * the only remaining defence is whichever forwarding header (or lack
 * of one) the tunnel provider happens to inject. ngrok is documented
 * to add `X-Forwarded-For`; nothing in this repo establishes that
 * localtunnel does, and the defense must not depend on an undocumented
 * third-party behavior. The tunnel DOES forward the public hostname as
 * `Host` (`Host: xyz.loca.lt`) rather than rewriting it to the local
 * target — this was the ORIGINAL (pre-audit) design's only signal, and
 * is restored here as one more OR-ed term, never as a replacement for
 * the peer check that closed H2.
 *
 * Algebra, so the next reader doesn't have to re-derive it: `viaProxy
 * = A || B || C || D` where D is `!isExpectedLocalHost(...)`. Adding a
 * term to an OR can only make `viaProxy` MORE often true — i.e. this
 * makes the gate strictly stricter, never more permissive. An attacker
 * can still spoof `Host: localhost` to make D false, but that only
 * declines to add a restriction; they still fail on A, which is
 * unspoofable (it's read from `PEER_ADDR_HEADER`, itself
 * server-stamped from `req.socket.remoteAddress` — see
 * `stampServerAuthoredHeaders`). H2 existed because `Host` was the
 * ONLY signal, so a spoof flipped the whole decision; as one term
 * among four it buys an attacker nothing.
 */
function isExpectedLocalHost(hostHeader: string | null, expectedBridgeHost: string | null): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  const configured = (expectedBridgeHost || "").trim().toLowerCase();
  return !!configured && hostname === configured;
}

/**
 * Decide whether a request qualifies for `proxy.ts`'s internal-token
 * bypass. Extracted to a pure function (same pattern as
 * `ptyWsAuth.ts#authorizePtyUpgrade`) so this GATE — as opposed to the
 * token comparison itself — can be exercised by a test without
 * booting Next.
 *
 * That distinction matters: `libs/__tests__/verifyRequestActor.test.ts`
 * already covered the token-verification layer and it was never
 * broken. What had zero coverage was this gate, which runs BEFORE the
 * token is ever consulted and can reject the request outright — which
 * is exactly how Next's `x-forwarded-for` auto-fill (see
 * `CLIENT_FORWARDED_FOR_HEADER`'s doc comment) silently killed the
 * whole bypass for every direct local caller without any test
 * noticing (audit finding).
 */
export function evaluateInternalTokenGate(input: InternalTokenGateInput): boolean {
  if (!input.internalToken || !input.configuredInternalToken) return false;

  const peer = normalizePeerAddr(input.peerAddr || "");
  const isLoopbackPeer = peer === "127.0.0.1" || peer === "::1";
  const viaProxy =
    !isLoopbackPeer ||
    !!input.clientForwardedFor ||
    !!input.xRealIp ||
    !!input.forwarded ||
    !isExpectedLocalHost(input.hostHeader, input.expectedBridgeHost);
  if (viaProxy) return false;

  return constantTimeStringEqual(input.internalToken, input.configuredInternalToken);
}
