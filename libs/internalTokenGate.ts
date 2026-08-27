import { constantTimeStringEqual } from "./auth";
import { normalizePeerAddr } from "./peerAddr";

export interface InternalTokenGateInput {
  peerAddr: string | null;
  clientForwardedFor: string | null;
  xRealIp: string | null;
  forwarded: string | null;
  hostHeader: string | null;
  expectedBridgeHost: string | null;
  internalToken: string | null;
  configuredInternalToken: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameOf(hostHeader: string): string {
  const lower = hostHeader.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(1, end);
  }
  return lower.split(":")[0] ?? "";
}

function isExpectedLocalHost(hostHeader: string | null, expectedBridgeHost: string | null): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  const configured = (expectedBridgeHost || "").trim().toLowerCase();
  return !!configured && hostname === configured;
}

export function evaluateInternalTokenGate(input: InternalTokenGateInput): boolean {
  if (!input.internalToken || !input.configuredInternalToken) return false;

  const peer = normalizePeerAddr(input.peerAddr || "");
  const isLoopbackPeer = peer === "127.0.0.1" || peer === "::1";
  const viaProxy =
    !isLoopbackPeer ||
    !!input.clientForwardedFor ||
    !!input.xRealIp ||
    !!input.forwarded ||
    !isExpectedLocalHost(input.hostHeader, input.expectedBridgeHost);
  if (viaProxy) return false;

  return constantTimeStringEqual(input.internalToken, input.configuredInternalToken);
}
