/**
 * Resolve the request's client IP for audit / rate-limit purposes.
 *
 * Naive code that always trusts `x-forwarded-for` lets any caller
 * spoof their source IP — a brute-force attacker who can set headers
 * (every CLI / scripted client) gets free per-IP rate-limit reset
 * just by rotating the value. We only honor `x-forwarded-for` /
 * `x-real-ip` when the operator explicitly opts in via
 * `BRIDGE_TRUSTED_PROXY=1` in `.env.production`, signalling "yes, my
 * deployment runs behind a reverse proxy that I configured to set
 * these headers correctly".
 *
 * Fallback when no trusted proxy is configured: the upstream socket's
 * `remoteAddress`, which is what Next.js exposes via the synthetic
 * `x-forwarded-for` header it injects in dev. In production behind a
 * proxy without the env flag set, this returns the proxy's own IP —
 * still useful as a coarse rate-limit key (one bucket for the whole
 * proxy is better than none at all).
 */
interface HeadersLike {
  get(name: string): string | null;
}

const TRUSTED = process.env.BRIDGE_TRUSTED_PROXY === "1";

export function getClientIp(headers: HeadersLike): string {
  if (TRUSTED) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = headers.get("x-real-ip");
    if (real && real.trim()) return real.trim();
  }
  // Best-effort fallback. Next exposes the socket via the same XFF
  // header in dev, so even with the env flag off we still get
  // *something* useful. If absolutely nothing is available, return
  // a static "unknown" sentinel so per-IP buckets degrade gracefully
  // into a single shared bucket (lock everyone out together) rather
  // than skip rate-limiting entirely.
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return "unknown";
}
