import { PEER_ADDR_HEADER, normalizePeerAddr } from "./peerAddr";

interface HeadersLike {
  get(name: string): string | null;
}

function trustsProxy(): boolean {
  return process.env.BRIDGE_TRUSTED_PROXY === "1";
}

/**
 * Identity used to bucket rate limits and to stamp access audit rows.
 *
 * Only X-Forwarded-For / X-Real-IP can be forged by a caller, so they are
 * read exclusively when the operator has declared a trusted proxy. The
 * fallback is the socket address the bridge server stamps itself in
 * `stampServerAuthoredHeaders` — client-supplied copies of that header are
 * stripped there, so it cannot be spoofed.
 */
export function getClientIp(headers: HeadersLike): string {
  if (trustsProxy()) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return normalizePeerAddr(first);
    }
    const real = headers.get("x-real-ip");
    if (real && real.trim()) return normalizePeerAddr(real.trim());
  }
  const peer = headers.get(PEER_ADDR_HEADER);
  if (peer && peer.trim()) return normalizePeerAddr(peer.trim());
  return "unknown";
}
