
import { updateBridgeManifest } from "./bridgeManifest";
import type { BridgeManifest } from "./apps/types";
import { normalizeStringList, readManifest } from "./apps/manifest";

export type DetectManifestSource = "auto" | "llm" | "heuristic";

export function getManifestDetectSource(): DetectManifestSource {
  const m = readManifest();
  const det = (m as { detect?: { source?: unknown } }).detect;
  const s = det?.source;
  if (s === "llm" || s === "heuristic" || s === "auto") return s;
  return "auto";
}

export function setManifestDetectSource(source: DetectManifestSource): void {
  updateBridgeManifest((m) => ({ ...m, detect: { source } }));
}

function normalizePublicUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return parsed.origin;
}

export function getManifestPublicUrl(): string {
  const m = readManifest();
  return normalizePublicUrl((m as { publicUrl?: unknown }).publicUrl);
}

export function setManifestPublicUrl(input: string): string {
  const normalized = normalizePublicUrl(input);
  const explicitClear = typeof input === "string" && input.trim() === "";
  if (!normalized && !explicitClear && typeof input === "string") {
    return getManifestPublicUrl();
  }
  updateBridgeManifest((m) => {
    const next: BridgeManifest = { ...(m as BridgeManifest) };
    if (normalized) {
      (next as { publicUrl?: string }).publicUrl = normalized;
    } else {
      delete (next as { publicUrl?: string }).publicUrl;
    }
    return next;
  });
  return normalized;
}

export interface TunnelAutoStart {
  enabled: boolean;
  provider: "localtunnel" | "ngrok";
  port: number;
}

interface TunnelsManifestSection {
  autoStart?: TunnelAutoStart;
  [key: string]: unknown;
}

export function getTunnelAutoStart(): TunnelAutoStart | null {
  const m = readManifest();
  const tunnels = (m as { tunnels?: TunnelsManifestSection }).tunnels;
  const a = tunnels?.autoStart;
  if (!a || typeof a !== "object") return null;
  const provider =
    a.provider === "ngrok" ? "ngrok" : a.provider === "localtunnel" ? "localtunnel" : null;
  const port = Number(a.port);
  if (!provider || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { enabled: a.enabled === true, provider, port };
}

export function setTunnelAutoStart(v: TunnelAutoStart | null): void {
  updateBridgeManifest((m) => {
    const next: BridgeManifest = { ...(m as BridgeManifest) };
    const tunnels: TunnelsManifestSection = {
      ...((next.tunnels as TunnelsManifestSection | undefined) ?? {}),
    };
    if (v) {
      tunnels.autoStart = { enabled: v.enabled, provider: v.provider, port: v.port };
    } else {
      delete tunnels.autoStart;
    }
    if (Object.keys(tunnels).length > 0) {
      (next as { tunnels?: TunnelsManifestSection }).tunnels = tunnels;
    } else {
      delete (next as { tunnels?: TunnelsManifestSection }).tunnels;
    }
    return next;
  });
}

export function getManifestDetectScanRoots(): string[] {
  const m = readManifest();
  const det = (m as { detect?: { scanRoots?: unknown } }).detect;
  return normalizeStringList(det?.scanRoots);
}

export function setManifestDetectScanRoots(roots: string[]): string[] {
  const cleaned = normalizeStringList(roots);
  updateBridgeManifest((m) => {
    const detPrev = (m as { detect?: Record<string, unknown> }).detect ?? {};
    const detNext: Record<string, unknown> = { ...detPrev };
    if (cleaned.length === 0) delete detNext.scanRoots;
    else detNext.scanRoots = cleaned;
    const next = { ...(m as BridgeManifest) };
    if (Object.keys(detNext).length === 0) {
      delete (next as { detect?: unknown }).detect;
    } else {
      (next as { detect?: Record<string, unknown> }).detect = detNext;
    }
    return next;
  });
  return cleaned;
}
