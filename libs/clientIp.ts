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
 * Without that opt-in we return the `"unknown"` sentinel rather than
 * reading XFF, so all unauthenticated traffic shares a single
 * rate-limit bucket. That's deliberately conservative: better to
 * collapse everyone into one bucket than to let an attacker pivot
 * through unbounded fake IPs.
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
  return "unknown";
}
