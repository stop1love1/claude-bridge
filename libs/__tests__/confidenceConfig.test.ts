import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  readConfidenceConfig,
  writeConfidenceConfig,
  _resetForTests,
  _internal,
} from "../confidenceConfig";

const { CONFIG_FILE } = _internal;
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

describe("confidenceConfig", () => {
  it("defaults to enabled / threshold 70", () => {
    const c = readConfidenceConfig();
    expect(c.enabled).toBe(true);
    expect(c.threshold).toBe(70);
  });
  it("patches + persists", () => {
    writeConfidenceConfig({ enabled: false, threshold: 85 });
    expect(readConfidenceConfig()).toEqual({ enabled: false, threshold: 85 });
  });
  it("clamps threshold to 0..100", () => {
    expect(writeConfidenceConfig({ threshold: -5 }).threshold).toBe(0);
    expect(writeConfidenceConfig({ threshold: 250 }).threshold).toBe(100);
  });
});
