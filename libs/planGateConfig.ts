import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";

const CONFIG_FILE = join(BRIDGE_STATE_DIR, "plan-gate.json");

export interface PlanGateConfig {
  operatorEnabled: boolean;
  maxClarifyRounds: number;
}

const DEFAULTS: PlanGateConfig = { operatorEnabled: true, maxClarifyRounds: 3 };

interface State {
  data: PlanGateConfig;
  loaded: boolean;
}
const G = globalThis as unknown as { __bridgePlanGateConfig?: State };
const state: State =
  G.__bridgePlanGateConfig ?? (G.__bridgePlanGateConfig = { data: { ...DEFAULTS }, loaded: false });

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<PlanGateConfig>;
      state.data = normalize({ ...DEFAULTS, ...parsed });
    }
  } catch {
    state.data = { ...DEFAULTS };
  }
  state.loaded = true;
}

function normalize(c: PlanGateConfig): PlanGateConfig {
  const n = Math.floor(Number(c.maxClarifyRounds));
  return {
    operatorEnabled: !!c.operatorEnabled,
    maxClarifyRounds: Number.isFinite(n) ? Math.max(1, n) : DEFAULTS.maxClarifyRounds,
  };
}

export function readPlanGateConfig(): PlanGateConfig {
  load();
  return { ...state.data };
}

export function writePlanGateConfig(patch: Partial<PlanGateConfig>): PlanGateConfig {
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
