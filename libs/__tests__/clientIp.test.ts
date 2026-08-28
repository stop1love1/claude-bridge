import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClientIp } from "../clientIp";
import { CLIENT_FORWARDED_FOR_HEADER, PEER_ADDR_HEADER } from "../peerAddr";

function headers(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

let originalTrusted: string | undefined;

beforeEach(() => {
  originalTrusted = process.env.BRIDGE_TRUSTED_PROXY;
  delete process.env.BRIDGE_TRUSTED_PROXY;
});

afterEach(() => {
  if (originalTrusted === undefined) delete process.env.BRIDGE_TRUSTED_PROXY;
  else process.env.BRIDGE_TRUSTED_PROXY = originalTrusted;
});

describe("getClientIp — untrusted (default) deployment", () => {
  it("uses the peer address the bridge server stamped from the socket", () => {
    expect(getClientIp(headers({ [PEER_ADDR_HEADER]: "192.168.1.42" }))).toBe("192.168.1.42");
  });

  it("normalizes an IPv4-mapped IPv6 peer to its dotted form", () => {
    expect(getClientIp(headers({ [PEER_ADDR_HEADER]: "::ffff:127.0.0.1" }))).toBe("127.0.0.1");
  });

  it("ignores a client-supplied X-Forwarded-For so a header cannot forge a bucket", () => {
    const h = headers({
      [PEER_ADDR_HEADER]: "10.0.0.7",
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
      [CLIENT_FORWARDED_FOR_HEADER]: "1.2.3.4",
    });
    expect(getClientIp(h)).toBe("10.0.0.7");
  });

  it("gives two different peers two different rate-limit keys", () => {
    const a = getClientIp(headers({ [PEER_ADDR_HEADER]: "10.0.0.1" }));
    const b = getClientIp(headers({ [PEER_ADDR_HEADER]: "10.0.0.2" }));
    expect(a).not.toBe(b);
  });

  it("falls back to unknown when nothing identifies the peer", () => {
    expect(getClientIp(headers({}))).toBe("unknown");
  });
});

describe("getClientIp — behind a trusted proxy", () => {
  beforeEach(() => {
    process.env.BRIDGE_TRUSTED_PROXY = "1";
  });

  it("takes the first entry of X-Forwarded-For", () => {
    const h = headers({
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      [PEER_ADDR_HEADER]: "127.0.0.1",
    });
    expect(getClientIp(h)).toBe("203.0.113.9");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const h = headers({ "x-real-ip": "203.0.113.10", [PEER_ADDR_HEADER]: "127.0.0.1" });
    expect(getClientIp(h)).toBe("203.0.113.10");
  });

  it("still falls back to the stamped peer address when the proxy sends neither", () => {
    expect(getClientIp(headers({ [PEER_ADDR_HEADER]: "127.0.0.1" }))).toBe("127.0.0.1");
  });
});
