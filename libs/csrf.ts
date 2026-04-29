/**
 * Cross-Site Request Forgery defence for cookie-authenticated routes.
 *
 * The bridge issues `bridge_session` cookies with `sameSite: "lax"`,
 * which already blocks the obvious cross-site form-POST attacks. The
 * remaining vector is a same-site sub-domain take-over: if the
 * operator visits `evil.<bridge-domain>` (or that's mounted by mistake
 * by the reverse proxy) the cookie is in scope and a POST goes
 * through. We close that gap with an Origin / Referer / Sec-Fetch-Site
 * check on every state-changing request.
 *
 * Algorithm (in order of preference):
 *   1. `Sec-Fetch-Site` is a Fetch Metadata header — every modern
 *      browser sends it on every request, no script can override it.
 *      `same-origin` and `none` are safe; anything else is rejected.
 *   2. `Origin` falls back for older clients. Compare its host
 *      against the request's own host — same-host is safe.
 *   3. As last resort fall back to `Referer` (same shape).
 *
 * `GET` / `HEAD` / `OPTIONS` are cacheable / idempotent and skipped.
 * Callers that send the per-install internal token are also skipped —
 * the CLI helpers (`approve-login.ts`, child agents) hit POST endpoints
 * with that header instead of a cookie, so they're not part of the
 * browser-CSRF threat model.
 */
import { INTERNAL_TOKEN_HEADER } from "./auth";

interface CsrfRequestLike {
  method: string;
  headers: { get(name: string): string | null };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Same-origin if hosts match. */
function hostFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

export interface CsrfResult {
  ok: boolean;
  reason?: string;
}

export function checkCsrf(req: CsrfRequestLike): CsrfResult {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return { ok: true };
  }

  // Internal-token callers (CLI scripts, agent hooks) bypass CSRF —
  // they don't carry a browser cookie, so a CSRF attack against them
  // has nothing to leverage.
  if (req.headers.get(INTERNAL_TOKEN_HEADER)) {
    return { ok: true };
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite === "same-origin" || fetchSite === "none") {
      return { ok: true };
    }
    return { ok: false, reason: `sec-fetch-site=${fetchSite}` };
  }

  // Browsers older than Sec-Fetch-Site (or non-browser clients) fall
  // back to Origin / Referer host equality. Reject when both are
  // missing — a state-changing browser request without either is
  // suspicious enough to drop.
  const host = (req.headers.get("host") || "").toLowerCase();
  const originHost = hostFromUrl(req.headers.get("origin"));
  const refererHost = hostFromUrl(req.headers.get("referer"));
  if (originHost && originHost === host) return { ok: true };
  if (!originHost && refererHost && refererHost === host) return { ok: true };
  if (!originHost && !refererHost) {
    return { ok: false, reason: "no origin/referer" };
  }
  return { ok: false, reason: "cross-origin" };
}
