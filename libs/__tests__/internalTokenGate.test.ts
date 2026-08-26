import { describe, expect, it } from "vitest";
import { evaluateInternalTokenGate } from "../internalTokenGate";

const TOKEN = "the-real-internal-token";

describe("evaluateInternalTokenGate", () => {
  it("fires for a genuine same-host request with a valid token", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(true);
  });

  it("normalizes an IPv4-mapped IPv6 loopback peer", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "::ffff:127.0.0.1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(true);
  });

  it("accepts the ::1 IPv6 loopback form", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "::1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(true);
  });

  it("rejects when no peer address reached us at all (the old Host-spoof case, now header-less)", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: null,
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it("rejects a genuinely remote peer address even with a valid token", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "203.0.113.9",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it(
    "REGRESSION (Next base-server auto-fill): a same-host peer with NO client-sent " +
      "x-forwarded-for still bypasses, even though Next's own base-server would have " +
      "unconditionally set the raw x-forwarded-for header to the socket address on " +
      "every request (base-server.js: `req.headers['x-forwarded-for'] ??= " +
      "req.socket.remoteAddress`). This function must be driven by the PRE-CAPTURED " +
      "client value, never the possibly-Next-mutated header, or the bypass dies for " +
      "every direct local caller.",
    () => {
      const ok = evaluateInternalTokenGate({
        peerAddr: "127.0.0.1",
        clientForwardedFor: null, // client sent nothing; caller must NOT pass Next's auto-filled xff here
        xRealIp: null,
        forwarded: null,
        internalToken: TOKEN,
        configuredInternalToken: TOKEN,
      });
      expect(ok).toBe(true);
    },
  );

  it("rejects a same-host peer when the client genuinely sent x-forwarded-for (real proxy chain)", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: "203.0.113.5",
      xRealIp: null,
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it("rejects a same-host peer when x-real-ip is present", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: null,
      xRealIp: "203.0.113.5",
      forwarded: null,
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it("rejects a same-host peer when forwarded (RFC 7239) is present", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: 'for="203.0.113.5"',
      internalToken: TOKEN,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it("rejects a wrong token even on a genuine same-host request", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: "wrong-token",
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it("rejects when no internal token header was sent", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: null,
      configuredInternalToken: TOKEN,
    });
    expect(ok).toBe(false);
  });

  it("rejects when no internal token is configured (default-allow trap)", () => {
    const ok = evaluateInternalTokenGate({
      peerAddr: "127.0.0.1",
      clientForwardedFor: null,
      xRealIp: null,
      forwarded: null,
      internalToken: "",
      configuredInternalToken: "",
    });
    expect(ok).toBe(false);
  });
});
