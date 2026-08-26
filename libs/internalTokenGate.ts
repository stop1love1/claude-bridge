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
  internalToken: string | null;
  configuredInternalToken: string;
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
    !!input.forwarded;
  if (viaProxy) return false;

  return constantTimeStringEqual(input.internalToken, input.configuredInternalToken);
}
