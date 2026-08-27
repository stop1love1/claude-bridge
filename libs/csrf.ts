import { INTERNAL_TOKEN_HEADER, constantTimeStringEqual, loadAuthConfig } from "./auth";

interface CsrfRequestLike {
  method: string;
  headers: { get(name: string): string | null };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

  const headerToken = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (headerToken) {
    const cfg = loadAuthConfig();
    if (cfg && constantTimeStringEqual(headerToken, cfg.internalToken)) {
      return { ok: true };
    }
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite === "same-origin" || fetchSite === "none") {
      return { ok: true };
    }
    return { ok: false, reason: `sec-fetch-site=${fetchSite}` };
  }

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
