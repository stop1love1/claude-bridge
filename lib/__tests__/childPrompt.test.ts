import { describe, it, expect } from "vitest";
import { buildChildPrompt } from "../childPrompt";
import type { RepoProfile } from "../repoProfile";

const baseOpts = {
  taskId: "t_20260425_001",
  taskTitle: "Add /users/me endpoint",
  taskBody: "Body of the task with details about /users/me.",
  parentSessionId: "11111111-1111-1111-1111-111111111111",
  childSessionId: "22222222-2222-2222-2222-222222222222",
  role: "coder",
  repo: "app-api",
  repoCwd: "/parent/app-api",
  contextBlock: "## Repo context\n(clean)",
  coordinatorBody: "Build the endpoint POST /users/me. Out of scope: auth.",
  bridgeFolder: "claude-bridge",
};

describe("buildChildPrompt", () => {
  it("emits sections in the contracted order", () => {
    const out = buildChildPrompt(baseOpts);
    const sections = [
      "## Language",
      "## Task",
      "## Your role",
      "## Repo profile",
      "## Repo context (auto-captured by bridge)",
      "## Self-register",
      "## Report contract — REQUIRED",
      "## Spawn-time signals",
    ];
    let cursor = 0;
    for (const s of sections) {
      const idx = out.indexOf(s, cursor);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx + s.length;
    }
  });

  it("inlines the coordinator body verbatim", () => {
    const out = buildChildPrompt(baseOpts);
    expect(out).toContain("Build the endpoint POST /users/me. Out of scope: auth.");
  });

  it("falls back gracefully when context block is empty", () => {
    const out = buildChildPrompt({ ...baseOpts, contextBlock: "" });
    expect(out).toContain("(none — bridge skipped pre-warm)");
  });

  it("falls back gracefully when profile is undefined", () => {
    const out = buildChildPrompt({ ...baseOpts, profile: undefined });
    expect(out).toContain("(no profile cached");
  });

  it("renders a profile bullet when one is provided", () => {
    const profile: RepoProfile = {
      name: "app-api",
      path: "/parent/app-api",
      summary: "API service",
      stack: ["nestjs", "prisma"],
      keywords: ["api"],
      features: ["auth", "lms"],
      entrypoints: ["src/**/*.controller.ts"],
      fileCounts: {},
      refreshedAt: new Date().toISOString(),
      signals: {
        hasPackageJson: true,
        hasReadme: true,
        hasClaudeMd: false,
        hasNextConfig: false,
        hasPrismaSchema: true,
        hasTailwindConfig: false,
        hasNestCoreDep: true,
        hasReactDep: false,
        routerStyle: "unknown",
        primaryLang: "ts",
      },
    };
    const out = buildChildPrompt({ ...baseOpts, profile });
    expect(out).toContain("**app-api**");
    expect(out).toContain("nestjs, prisma");
    expect(out).toContain("auth, lms");
  });

  it("caps coordinator body at 16 KB", () => {
    const huge = "x".repeat(20 * 1024);
    const out = buildChildPrompt({ ...baseOpts, coordinatorBody: huge });
    expect(out).toContain("(truncated by bridge — coordinator brief exceeded 16 KB cap)");
  });

  it("substitutes a placeholder when the coordinator body is empty", () => {
    const out = buildChildPrompt({ ...baseOpts, coordinatorBody: "  " });
    expect(out).toContain("(coordinator did not provide a role-specific brief");
  });

  it("includes the child session UUID in the self-register snippet", () => {
    const out = buildChildPrompt(baseOpts);
    expect(out).toContain('"sessionId":"22222222-2222-2222-2222-222222222222"');
    expect(out).toContain(`/api/tasks/${baseOpts.taskId}/link`);
  });

  it("includes the report path in the report contract using bridgeFolder", () => {
    const out = buildChildPrompt(baseOpts);
    expect(out).toContain(
      `../${baseOpts.bridgeFolder}/sessions/${baseOpts.taskId}/reports/${baseOpts.role}-${baseOpts.repo}.md`,
    );
  });

  it("falls back to runtime BRIDGE_FOLDER when bridgeFolder is omitted", () => {
    const { bridgeFolder: _omitted, ...rest } = baseOpts;
    const out = buildChildPrompt(rest);
    expect(out).toMatch(/\.\.\/[^/]+\/sessions\//);
  });
});
