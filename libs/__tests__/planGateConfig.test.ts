import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  readPlanGateConfig,
  writePlanGateConfig,
  _resetForTests,
  _internal,
} from "../planGateConfig";

const { CONFIG_FILE } = _internal;

// planGateConfig binds its file to the real `.bridge-state` dir; snapshot
// and restore so a developer's live gate config isn't disturbed by the suite.
let saved: string | null = null;

beforeEach(() => {
  saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
  _resetForTests();
});

afterEach(() => {
  if (saved !== null) writeFileSync(CONFIG_FILE, saved, "utf8");
  else if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
  _resetForTests();
});

describe("planGateConfig", () => {
  it("defaults to operator gate on, 3 clarify rounds", () => {
    const c = readPlanGateConfig();
    expect(c.operatorEnabled).toBe(true);
    expect(c.maxClarifyRounds).toBe(3);
  });

  it("patches and persists fields", () => {
    const c = writePlanGateConfig({ operatorEnabled: false });
    expect(c.operatorEnabled).toBe(false);
    expect(c.maxClarifyRounds).toBe(3);
    expect(readPlanGateConfig().operatorEnabled).toBe(false);
  });

  it("clamps maxClarifyRounds to >= 1", () => {
    expect(writePlanGateConfig({ maxClarifyRounds: 0 }).maxClarifyRounds).toBe(1);
    expect(writePlanGateConfig({ maxClarifyRounds: -5 }).maxClarifyRounds).toBe(1);
  });
});
