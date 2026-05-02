import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCsrf } from "../csrf";
import * as auth from "../auth";

function makeReq(opts: {
  method?: string;
  host?: string;
  origin?: string;
  referer?: string;
  fetchSite?: string;
  internal?: string;
}): { method: string; headers: { get(name: string): string | null } } {
  const headers = new Map<string, string>();
  if (opts.host) headers.set("host", opts.host);
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.referer) headers.set("referer", opts.referer);
  if (opts.fetchSite) headers.set("sec-fetch-site", opts.fetchSite);
  if (opts.internal) headers.set("x-bridge-internal-token", opts.internal);
  return {
    method: opts.method ?? "POST",
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
    },
  };
}

describe("checkCsrf — safe methods", () => {
  for (const m of ["GET", "HEAD", "OPTIONS", "get", "head", "options"]) {
    it(`accepts ${m} unconditionally`, () => {
      // No origin / referer / fetch-site headers — should still pass.
      expect(checkCsrf(makeReq({ method: m })).ok).toBe(true);
    });
  }
});

describe("checkCsrf — internal-token bypass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a POST whose internal-token header matches the configured secret", () => {
    vi.spyOn(auth, "loadAuthConfig").mockReturnValue({
      email: "op@example.com",
      passwordHash: "scrypt$1$1$1$AAA$BBB",
      secret: "test-secret",
      internalToken: "real-token",
      trustedDevices: [],
    });
    expect(
      checkCsrf(makeReq({ method: "POST", internal: "real-token" })).ok,
    ).toBe(true);
  });

  it("falls through to origin checks when the internal-token does NOT match", () => {
    vi.spyOn(auth, "loadAuthConfig").mockReturnValue({
      email: "op@example.com",
      passwordHash: "scrypt$1$1$1$AAA$BBB",
      secret: "test-secret",
      internalToken: "real-token",
      trustedDevices: [],
    });
    // Wrong token + same-origin Sec-Fetch-Site → still passes via fetch-site.
    expect(
      checkCsrf(makeReq({
        method: "POST",
        internal: "wrong-token",
        fetchSite: "same-origin",
      })).ok,
    ).toBe(true);
    // Wrong token + cross-site → rejected; header presence alone is not a bypass.
    const r = checkCsrf(makeReq({
      method: "POST",
      internal: "wrong-token",
      fetchSite: "cross-site",
    }));
    expect(r.ok).toBe(false);
  });

  it("rejects when auth isn't configured even if header is present", () => {
    vi.spyOn(auth, "loadAuthConfig").mockReturnValue(null);
    const r = checkCsrf(makeReq({
      method: "POST",
      host: "bridge.local",
      internal: "any-token",
    }));
    // No origin/referer + no valid token → rejected.
    expect(r.ok).toBe(false);
  });
});

describe("checkCsrf — Sec-Fetch-Site path", () => {
  it("accepts same-origin", () => {
    expect(
      checkCsrf(makeReq({ method: "POST", fetchSite: "same-origin" })).ok,
    ).toBe(true);
  });

  it("accepts none (top-level navigation)", () => {
    expect(
      checkCsrf(makeReq({ method: "POST", fetchSite: "none" })).ok,
    ).toBe(true);
  });

  it("rejects same-site (sub-domain takeover scenario)", () => {
    const r = checkCsrf(makeReq({ method: "POST", fetchSite: "same-site" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("same-site");
  });

  it("rejects cross-site outright", () => {
    const r = checkCsrf(makeReq({ method: "POST", fetchSite: "cross-site" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("cross-site");
  });
});

describe("checkCsrf — Origin/Referer fallback", () => {
  it("accepts when Origin host matches the request host", () => {
    expect(
      checkCsrf(makeReq({
        method: "POST",
        host: "bridge.local",
        origin: "https://bridge.local/foo",
      })).ok,
    ).toBe(true);
  });

  it("ignores port differences in host string", () => {
    // Origin includes :7777, host header from `host:port`. The check
    // compares full host (including port), so they must match.
    expect(
      checkCsrf(makeReq({
        method: "POST",
        host: "bridge.local:7777",
        origin: "https://bridge.local:7777/foo",
      })).ok,
    ).toBe(true);
  });

  it("rejects when Origin host differs from request host", () => {
    const r = checkCsrf(makeReq({
      method: "POST",
      host: "bridge.local",
      origin: "https://evil.example/foo",
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("cross-origin");
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(
      checkCsrf(makeReq({
        method: "POST",
        host: "bridge.local",
        referer: "https://bridge.local/page",
      })).ok,
    ).toBe(true);
  });

  it("does NOT use Referer when Origin is present but mismatched", () => {
    const r = checkCsrf(makeReq({
      method: "POST",
      host: "bridge.local",
      origin: "https://evil.example",
      referer: "https://bridge.local/page",
    }));
    expect(r.ok).toBe(false);
  });

  it("rejects when both Origin and Referer are missing on a state-changing request", () => {
    const r = checkCsrf(makeReq({ method: "POST", host: "bridge.local" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no origin/referer");
  });

  it("rejects malformed Origin URLs", () => {
    const r = checkCsrf(makeReq({
      method: "POST",
      host: "bridge.local",
      origin: "not a url",
    }));
    expect(r.ok).toBe(false);
  });
});
