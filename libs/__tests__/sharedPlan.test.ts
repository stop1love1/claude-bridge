import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mktmp(): string {
  return mkdtempSync(join(tmpdir(), `bridge-shared-plan-`));
}

describe("sharedPlan", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp();
    // Spy on process.cwd() (no real chdir) so the freshly re-imported
    // paths.ts resolves SESSIONS_DIR against our temp fixture.
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when no plan.md exists", async () => {
    const { loadSharedPlan } = await import("../sharedPlan");
    expect(loadSharedPlan("t_20260501_001")).toBeNull();
  });

  it("loads plan.md content when present", async () => {
    const taskDir = join(tmpRoot, "sessions", "t_20260501_001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "plan.md"), "# Plan\n\n## Goal\nShip the thing.");
    const { loadSharedPlan } = await import("../sharedPlan");
    const plan = loadSharedPlan("t_20260501_001");
    expect(plan).not.toBeNull();
    expect(plan).toContain("# Plan");
    expect(plan).toContain("Ship the thing.");
  });

  it("treats whitespace-only plan.md as missing", async () => {
    const taskDir = join(tmpRoot, "sessions", "t_20260501_002");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "plan.md"), "   \n\n  ");
    const { loadSharedPlan } = await import("../sharedPlan");
    expect(loadSharedPlan("t_20260501_002")).toBeNull();
  });

  it("appends a truncation notice when plan.md exceeds the cap", async () => {
    const taskDir = join(tmpRoot, "sessions", "t_20260501_003");
    mkdirSync(taskDir, { recursive: true });
    // 20 KB of `x` blows past the 16 KB cap.
    writeFileSync(join(taskDir, "plan.md"), "x".repeat(20 * 1024));
    const { loadSharedPlan, SHARED_PLAN_CAP_BYTES } = await import("../sharedPlan");
    const plan = loadSharedPlan("t_20260501_003");
    expect(plan).not.toBeNull();
    expect(plan).toContain("plan.md truncated at 16 KB");
    // Content portion (before the appended notice) is bounded by the cap.
    expect(SHARED_PLAN_CAP_BYTES).toBe(16 * 1024);
  });

  it("sharedPlanPath builds the canonical path under sessions/<id>/plan.md", async () => {
    const { sharedPlanPath } = await import("../sharedPlan");
    const p = sharedPlanPath("t_20260501_004");
    expect(p.endsWith(join("sessions", "t_20260501_004", "plan.md"))).toBe(true);
  });
});
