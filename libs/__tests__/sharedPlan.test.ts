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

  it("rolePlanPath builds plan-<role>.md under the task dir", async () => {
    const { rolePlanPath } = await import("../sharedPlan");
    const p = rolePlanPath("t_20260501_005", "planner-api");
    expect(p.endsWith(join("sessions", "t_20260501_005", "plan-planner-api.md"))).toBe(true);
  });

  it("loads ONLY per-role plan files when no unscoped plan.md exists", async () => {
    const id = "t_20260501_006";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "plan-planner-api.md"),
      "## Goal\nExpose /finance/refunds/summary endpoint.",
    );
    writeFileSync(
      join(taskDir, "plan-planner-ui.md"),
      "## Goal\nAdd 4 summary cards on Refunds page.",
    );
    const { loadSharedPlan } = await import("../sharedPlan");
    const plan = loadSharedPlan(id);
    expect(plan).not.toBeNull();
    expect(plan).toContain("### From planner-api");
    expect(plan).toContain("### From planner-ui");
    expect(plan).toContain("/finance/refunds/summary");
    expect(plan).toContain("4 summary cards");
    // Separator between slots
    expect(plan).toContain("\n\n---\n\n");
  });

  it("concatenates unscoped plan.md and per-role files with a legacy header", async () => {
    const id = "t_20260501_007";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "plan.md"), "## Goal\nLegacy shared plan content.");
    writeFileSync(
      join(taskDir, "plan-planner-api.md"),
      "## Goal\nBackend contract.",
    );
    const { loadSharedPlan } = await import("../sharedPlan");
    const plan = loadSharedPlan(id);
    expect(plan).not.toBeNull();
    expect(plan).toContain("### From planner (legacy / shared)");
    expect(plan).toContain("### From planner-api");
    expect(plan).toContain("Legacy shared plan content.");
    expect(plan).toContain("Backend contract.");
  });

  it("emits per-role slots in alphabetical role order (deterministic)", async () => {
    const id = "t_20260501_008";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "plan-zebra.md"), "z");
    writeFileSync(join(taskDir, "plan-alpha.md"), "a");
    writeFileSync(join(taskDir, "plan-mango.md"), "m");
    const { loadSharedPlan } = await import("../sharedPlan");
    const plan = loadSharedPlan(id)!;
    const a = plan.indexOf("### From alpha");
    const m = plan.indexOf("### From mango");
    const z = plan.indexOf("### From zebra");
    expect(a).toBeGreaterThan(-1);
    expect(m).toBeGreaterThan(a);
    expect(z).toBeGreaterThan(m);
  });

  it("skips empty per-role files (whitespace only)", async () => {
    const id = "t_20260501_009";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "plan-planner-api.md"), "real content");
    writeFileSync(join(taskDir, "plan-planner-empty.md"), "   \n  \n");
    const { loadSharedPlan } = await import("../sharedPlan");
    const plan = loadSharedPlan(id)!;
    expect(plan).toContain("### From planner-api");
    expect(plan).not.toContain("### From planner-empty");
  });

  it("returns single-slot plan.md verbatim (no merge headers) for back-compat", async () => {
    const id = "t_20260501_010";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    const body = "# Plan\n\n## Goal\nSingle planner case.";
    writeFileSync(join(taskDir, "plan.md"), body);
    const { loadSharedPlan } = await import("../sharedPlan");
    const plan = loadSharedPlan(id);
    expect(plan).toBe(body);
    // No merge separator when there's only one slot.
    expect(plan).not.toContain("### From ");
  });
});
