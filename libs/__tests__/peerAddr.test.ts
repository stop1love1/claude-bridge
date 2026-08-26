import { describe, expect, it } from "vitest";
import {
  CLIENT_FORWARDED_FOR_HEADER,
  PEER_ADDR_HEADER,
  normalizePeerAddr,
  stampServerAuthoredHeaders,
} from "../peerAddr";

/**
 * These two headers are the entire security boundary for the
 * same-host gate in `libs/internalTokenGate.ts` — the gate trusts
 * them unconditionally. Nothing that tests the gate itself can prove
 * the delete-before-stamp actually runs, because the gate is always
 * fed already-sanitized values by construction (it has no way to
 * receive a "raw, unsanitized" input). Only a test at THIS layer,
 * against the function that does the deleting, can pin that.
 */
function fakeReq(opts: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string | null;
}): { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string | null } } {
  return {
    headers: { ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remoteAddress ?? null },
  };
}

describe("stampServerAuthoredHeaders", () => {
  it("stamps the real peer address when no inbound headers are present", () => {
    const req = fakeReq({ remoteAddress: "127.0.0.1" });
    stampServerAuthoredHeaders(req);
    expect(req.headers[PEER_ADDR_HEADER]).toBe("127.0.0.1");
    expect(req.headers[CLIENT_FORWARDED_FOR_HEADER]).toBeUndefined();
  });

  it("discards a client-forged PEER_ADDR_HEADER and stamps the true socket address instead", () => {
    const req = fakeReq({
      headers: { [PEER_ADDR_HEADER]: "6.6.6.6" },
      remoteAddress: "127.0.0.1",
    });
    stampServerAuthoredHeaders(req);
    expect(req.headers[PEER_ADDR_HEADER]).toBe("127.0.0.1");
  });

  it("discards a client-forged CLIENT_FORWARDED_FOR_HEADER when the client sent no real x-forwarded-for", () => {
    const req = fakeReq({
      headers: { [CLIENT_FORWARDED_FOR_HEADER]: "9.9.9.9" },
      remoteAddress: "127.0.0.1",
    });
    stampServerAuthoredHeaders(req);
    expect(req.headers[CLIENT_FORWARDED_FOR_HEADER]).toBeUndefined();
  });

  it("discards forged copies of BOTH headers in the same request", () => {
    const req = fakeReq({
      headers: {
        [PEER_ADDR_HEADER]: "6.6.6.6",
        [CLIENT_FORWARDED_FOR_HEADER]: "9.9.9.9",
      },
      remoteAddress: "203.0.113.9",
    });
    stampServerAuthoredHeaders(req);
    expect(req.headers[PEER_ADDR_HEADER]).toBe("203.0.113.9");
    expect(req.headers[CLIENT_FORWARDED_FOR_HEADER]).toBeUndefined();
  });

  it("captures the client's genuine x-forwarded-for", () => {
    const req = fakeReq({
      headers: { "x-forwarded-for": "203.0.113.5" },
      remoteAddress: "127.0.0.1",
    });
    stampServerAuthoredHeaders(req);
    expect(req.headers[CLIENT_FORWARDED_FOR_HEADER]).toBe("203.0.113.5");
  });

  it("is array-safe reading x-forwarded-for (Node may deliver duplicate headers as an array)", () => {
    const req = fakeReq({
      headers: { "x-forwarded-for": ["203.0.113.5", "198.51.100.1"] },
      remoteAddress: "127.0.0.1",
    });
    stampServerAuthoredHeaders(req);
    expect(req.headers[CLIENT_FORWARDED_FOR_HEADER]).toBe("203.0.113.5");
  });

  it("leaves PEER_ADDR_HEADER absent (not stamped, not left forged) when the socket has no remote address", () => {
    const req = fakeReq({
      headers: { [PEER_ADDR_HEADER]: "6.6.6.6" },
      remoteAddress: null,
    });
    stampServerAuthoredHeaders(req);
    expect(req.headers[PEER_ADDR_HEADER]).toBeUndefined();
  });
});

describe("normalizePeerAddr", () => {
  it("strips the IPv4-mapped IPv6 prefix", () => {
    expect(normalizePeerAddr("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  it("leaves a plain address untouched", () => {
    expect(normalizePeerAddr("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePeerAddr("::1")).toBe("::1");
  });
});
