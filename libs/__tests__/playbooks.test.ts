import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mktmp(): string {
  return mkdtempSync(join(tmpdir(), `bridge-playbook-`));
}

describe("playbooks", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp();
    // Spy on process.cwd() (no real chdir) so the freshly re-imported
    // paths.ts resolves BRIDGE_LOGIC_DIR against our temp fixture.
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when no playbook file exists", async () => {
    const { loadPlaybook } = await import("../playbooks");
    expect(loadPlaybook("reviewer")).toBeNull();
  });

  it("loads a playbook by role name", async () => {
    mkdirSync(join(tmpRoot, "prompts", "playbooks"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "prompts", "playbooks", "reviewer.md"),
      "Reviewer rubric: ship/needs-rework/blocked.",
    );
    const { loadPlaybook } = await import("../playbooks");
    expect(loadPlaybook("reviewer")).toContain("Reviewer rubric");
  });

  it("rejects roles outside the validated charset (no path traversal)", async () => {
    const { loadPlaybook } = await import("../playbooks");
    expect(loadPlaybook("../etc/passwd")).toBeNull();
    expect(loadPlaybook("a/b")).toBeNull();
    expect(loadPlaybook("")).toBeNull();
    expect(loadPlaybook("with space")).toBeNull();
  });

  it("treats whitespace-only files as missing", async () => {
    mkdirSync(join(tmpRoot, "prompts", "playbooks"), { recursive: true });
    writeFileSync(join(tmpRoot, "prompts", "playbooks", "coder.md"), "   \n\n  ");
    const { loadPlaybook } = await import("../playbooks");
    expect(loadPlaybook("coder")).toBeNull();
  });

  it("playbookPath builds the canonical path under prompts/playbooks/", async () => {
    const { playbookPath } = await import("../playbooks");
    const p = playbookPath("style-critic");
    expect(p.endsWith(join("prompts", "playbooks", "style-critic.md"))).toBe(true);
  });
});
