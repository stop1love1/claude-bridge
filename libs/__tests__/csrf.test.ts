import { describe, expect, it } from "vitest";
import { checkCsrf } from "../csrf";

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
  it("accepts a POST that carries the internal-token header", () => {
    expect(
      checkCsrf(makeReq({ method: "POST", internal: "any-token-value" })).ok,
    ).toBe(true);
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
