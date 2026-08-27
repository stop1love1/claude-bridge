import { describe, expect, it } from "vitest";
import { evaluateInternalTokenGate } from "../internalTokenGate";

const TOKEN = "the-real-internal-token";

const BASE = {
  peerAddr: "127.0.0.1",
  clientForwardedFor: null as string | null,
  xRealIp: null as string | null,
  forwarded: null as string | null,
  hostHeader: "localhost:7777",
  expectedBridgeHost: null as string | null,
  internalToken: TOKEN,
  configuredInternalToken: TOKEN,
};

describe("evaluateInternalTokenGate", () => {
  it("fires for a genuine same-host request with a valid token", () => {
    expect(evaluateInternalTokenGate({ ...BASE })).toBe(true);
  });

  it("normalizes an IPv4-mapped IPv6 loopback peer", () => {
    expect(evaluateInternalTokenGate({ ...BASE, peerAddr: "::ffff:127.0.0.1" })).toBe(true);
  });

  it("accepts the ::1 IPv6 loopback form", () => {
    expect(evaluateInternalTokenGate({ ...BASE, peerAddr: "::1" })).toBe(true);
  });

  it("rejects when no peer address reached us at all (the old Host-spoof case, now header-less)", () => {
    expect(evaluateInternalTokenGate({ ...BASE, peerAddr: null })).toBe(false);
  });

  it("rejects a genuinely remote peer address even with a valid token", () => {
    expect(evaluateInternalTokenGate({ ...BASE, peerAddr: "203.0.113.9" })).toBe(false);
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
      expect(evaluateInternalTokenGate({ ...BASE, clientForwardedFor: null })).toBe(true);
    },
  );

  it("rejects a same-host peer when the client genuinely sent x-forwarded-for (real proxy chain)", () => {
    expect(evaluateInternalTokenGate({ ...BASE, clientForwardedFor: "203.0.113.5" })).toBe(false);
  });

  it("rejects a same-host peer when x-real-ip is present", () => {
    expect(evaluateInternalTokenGate({ ...BASE, xRealIp: "203.0.113.5" })).toBe(false);
  });

  it("rejects a same-host peer when forwarded (RFC 7239) is present", () => {
    expect(evaluateInternalTokenGate({ ...BASE, forwarded: 'for="203.0.113.5"' })).toBe(false);
  });

  it("rejects a wrong token even on a genuine same-host request", () => {
    expect(evaluateInternalTokenGate({ ...BASE, internalToken: "wrong-token" })).toBe(false);
  });

  it("rejects when no internal token header was sent", () => {
    expect(evaluateInternalTokenGate({ ...BASE, internalToken: null })).toBe(false);
  });

  it("rejects when no internal token is configured (default-allow trap)", () => {
    expect(
      evaluateInternalTokenGate({ ...BASE, internalToken: "", configuredInternalToken: "" }),
    ).toBe(false);
  });


  it("accepts localhost as an expected local Host, any port", () => {
    expect(evaluateInternalTokenGate({ ...BASE, hostHeader: "localhost:9999" })).toBe(true);
  });

  it("accepts 127.0.0.1 as an expected local Host", () => {
    expect(evaluateInternalTokenGate({ ...BASE, hostHeader: "127.0.0.1:7777" })).toBe(true);
  });

  it("accepts the bracketed IPv6 loopback Host form", () => {
    expect(evaluateInternalTokenGate({ ...BASE, hostHeader: "[::1]:7777" })).toBe(true);
  });

  it("accepts Host case-insensitively", () => {
    expect(evaluateInternalTokenGate({ ...BASE, hostHeader: "LOCALHOST:7777" })).toBe(true);
  });

  it(
    "REGRESSION (co-located tunnel, finding 1): a loopback peer with a tunnel's public " +
      "Host and no forwarding headers must now be rejected — this is the exact topology " +
      "libs/tunnels.ts spawns (localtunnel/ngrok on the same machine), and it is the case " +
      "the old Host-only check caught that the peer-address-only gate cannot.",
    () => {
      expect(evaluateInternalTokenGate({ ...BASE, hostHeader: "abc123.loca.lt" })).toBe(false);
    },
  );

  it("rejects an ngrok-style tunnel Host the same way", () => {
    expect(evaluateInternalTokenGate({ ...BASE, hostHeader: "abc123.ngrok-free.app" })).toBe(false);
  });

  it("rejects when the Host header is missing entirely (fail toward restriction)", () => {
    expect(evaluateInternalTokenGate({ ...BASE, hostHeader: null })).toBe(false);
  });

  it("accepts a configured BRIDGE_HOST literal as an expected local Host", () => {
    expect(
      evaluateInternalTokenGate({
        ...BASE,
        hostHeader: "192.168.1.50:7777",
        expectedBridgeHost: "192.168.1.50",
      }),
    ).toBe(true);
  });

  it("still rejects a tunnel Host even when a BRIDGE_HOST override is configured for something else", () => {
    expect(
      evaluateInternalTokenGate({
        ...BASE,
        hostHeader: "abc123.loca.lt",
        expectedBridgeHost: "192.168.1.50",
      }),
    ).toBe(false);
  });

  it("matches BRIDGE_HOST case-insensitively", () => {
    expect(
      evaluateInternalTokenGate({
        ...BASE,
        hostHeader: "Bridge-Host.example:7777",
        expectedBridgeHost: "bridge-host.example",
      }),
    ).toBe(true);
  });

  it("does not treat an unrelated custom Host as local just because SOME BRIDGE_HOST is configured", () => {
    expect(
      evaluateInternalTokenGate({
        ...BASE,
        hostHeader: "attacker.example:7777",
        expectedBridgeHost: "192.168.1.50",
      }),
    ).toBe(false);
  });
});
