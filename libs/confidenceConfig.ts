import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";
import type { ConfidenceGateConfig } from "./confidenceScore";

const CONFIG_FILE = join(BRIDGE_STATE_DIR, "confidence.json");

const DEFAULTS: ConfidenceGateConfig = { enabled: true, threshold: 70, holdWorktree: false };

interface State {
  data: ConfidenceGateConfig;
  loaded: boolean;
}
const G = globalThis as unknown as { __bridgeConfidenceConfig?: State };
const state: State =
  G.__bridgeConfidenceConfig ?? (G.__bridgeConfidenceConfig = { data: { ...DEFAULTS }, loaded: false });

function clampThreshold(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : DEFAULTS.threshold;
}

function normalize(c: ConfidenceGateConfig): ConfidenceGateConfig {
  return { enabled: !!c.enabled, threshold: clampThreshold(c.threshold), holdWorktree: !!c.holdWorktree };
}

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<ConfidenceGateConfig>;
      state.data = normalize({ ...DEFAULTS, ...parsed });
    }
  } catch {
    state.data = { ...DEFAULTS };
  }
  state.loaded = true;
}

export function readConfidenceConfig(): ConfidenceGateConfig {
  load();
  return { ...state.data };
}

export function writeConfidenceConfig(patch: Partial<ConfidenceGateConfig>): ConfidenceGateConfig {
  load();
  state.data = normalize({ ...state.data, ...patch });
  writeJsonAtomic(CONFIG_FILE, state.data);
  return { ...state.data };
}

export function _resetForTests(): void {
  state.data = { ...DEFAULTS };
  state.loaded = true;
}

export const _internal = { CONFIG_FILE };
