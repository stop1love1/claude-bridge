import { describe, it, expect } from "vitest";
import { buildTeamHint } from "../teamHints";
import type { DetectedScope } from "../detect/types";
import type { RepoProfile } from "../repoProfile";

const scope = (repos: { name: string; score: number }[]): DetectedScope => ({
  repos: repos.map((r) => ({ name: r.name, score: r.score, reason: "test" })),
  features: [],
  entities: [],
  files: [],
  confidence: "medium",
  source: "heuristic",
  detectedAt: "2026-05-16T00:00:00.000Z",
  reason: "test",
});

const profile = (overrides: Partial<RepoProfile> = {}): RepoProfile => ({
  name: "test-repo",
  path: "/x",
  summary: "test",
  stack: [],
  keywords: [],
  features: [],
  entrypoints: [],
  fileCounts: {},
  refreshedAt: "2026-05-16T00:00:00.000Z",
  signals: {
    hasPackageJson: true,
    hasReadme: false,
    hasClaudeMd: false,
    hasNextConfig: false,
    hasPrismaSchema: false,
    hasTailwindConfig: false,
    hasNestCoreDep: false,
    hasReactDep: false,
    routerStyle: "unknown",
    primaryLang: "unknown",
  },
  ...overrides,
});

describe("buildTeamHint — UX/UI on FE-stack repo", () => {
  it("suggests coder→ui-tester when task body has UI keywords and repo has FE stack", () => {
    const hint = buildTeamHint({
      taskBody: "Fix the modal that doesn't open and the table column overflow on the refunds page",
      detectedScope: scope([{ name: "web", score: 90 }]),
      profiles: { web: profile({ name: "web", stack: ["next", "react", "tailwind"] }) },
    });
    expect(hint).not.toBeNull();
    expect(hint!.block).toContain("coder");
    expect(hint!.block).toContain("ui-tester");
    expect(hint!.summary.suggested).toBe("coder → ui-tester");
    expect(hint!.summary.matchedStack).toContain("next");
  });

  it("matches Vietnamese UX keywords", () => {
    const hint = buildTeamHint({
      taskBody: "Sửa giao diện trang refunds, thêm summary cards và empty state cho bảng",
      detectedScope: scope([{ name: "web", score: 90 }]),
      profiles: { web: profile({ name: "web", stack: ["vue"] }) },
    });
    expect(hint).not.toBeNull();
    expect(hint!.summary.matchedKeywords.length).toBeGreaterThan(0);
  });

  it("returns null when task has UX keywords but repo is backend-only", () => {
    const hint = buildTeamHint({
      taskBody: "Add UI for the form",
      detectedScope: scope([{ name: "api", score: 90 }]),
      profiles: { api: profile({ name: "api", stack: ["nestjs", "prisma"] }) },
    });
    expect(hint).toBeNull();
  });

  it("returns null when repo is FE but task body has no UX signal", () => {
    const hint = buildTeamHint({
      taskBody: "Migrate dependency versions and run codemod across the package",
      detectedScope: scope([{ name: "web", score: 90 }]),
      profiles: { web: profile({ name: "web", stack: ["react"] }) },
    });
    expect(hint).toBeNull();
  });

  it("returns null when no scope is available", () => {
    expect(
      buildTeamHint({
        taskBody: "Add a modal",
        detectedScope: null,
        profiles: { web: profile({ name: "web", stack: ["react"] }) },
      }),
    ).toBeNull();
  });

  it("returns null when no profile exists for the top-scored repo", () => {
    expect(
      buildTeamHint({
        taskBody: "Add a modal",
        detectedScope: scope([{ name: "ghost-repo", score: 90 }]),
        profiles: {},
      }),
    ).toBeNull();
  });

  it("uses word-boundary matching for short keywords (no false positive on 'format')", () => {
    const hint = buildTeamHint({
      taskBody: "Fix the format function that returns the wrong string",
      detectedScope: scope([{ name: "web", score: 90 }]),
      profiles: { web: profile({ name: "web", stack: ["react"] }) },
    });
    // "form" should not match inside "format" — no UX hits → null
    expect(hint).toBeNull();
  });

  it("picks the first FE-stack repo when multiple are scoped", () => {
    const hint = buildTeamHint({
      taskBody: "Add a popup with a search filter",
      detectedScope: scope([
        { name: "api", score: 80 },
        { name: "web", score: 70 },
      ]),
      profiles: {
        api: profile({ name: "api", stack: ["nestjs"] }),
        web: profile({ name: "web", stack: ["next", "react"] }),
      },
    });
    expect(hint).not.toBeNull();
    expect(hint!.summary.matchedRepo).toBe("web");
  });
});
