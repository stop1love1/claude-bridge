import { describe, it, expect } from "vitest";
import { parseApps, serializeApps, type App } from "../apps";

/**
 * Focused tests for the P1/D1 `verify` field round-trip. The full apps
 * loader has a lot more surface (git settings, atomic writes, name
 * validation) — those are covered by integration via the existing API
 * routes; here we lock down the new field's normalize/serialize behavior.
 */
describe("apps.verify (D1)", () => {
  it("defaults to empty when the manifest entry has no verify key", () => {
    const json = JSON.stringify({
      version: 1,
      apps: [{ name: "app-web", path: "../app-web" }],
    });
    const apps = parseApps(json);
    expect(apps).toHaveLength(1);
    expect(apps[0].verify).toEqual({});
  });

  it("accepts string commands and trims whitespace", () => {
    const json = JSON.stringify({
      version: 1,
      apps: [{
        name: "app-web",
        path: "../app-web",
        verify: { test: "  bun test  ", lint: "eslint .", build: "bun run build" },
      }],
    });
    const apps = parseApps(json);
    expect(apps[0].verify.test).toBe("bun test");
    expect(apps[0].verify.lint).toBe("eslint .");
    expect(apps[0].verify.build).toBe("bun run build");
  });

  it("drops empty / non-string command values", () => {
    const json = JSON.stringify({
      version: 1,
      apps: [{
        name: "app-web",
        path: "../app-web",
        verify: { test: "", lint: "   ", build: 42, typecheck: "tsc --noEmit" },
      }],
    });
    const apps = parseApps(json);
    expect(apps[0].verify.test).toBeUndefined();
    expect(apps[0].verify.lint).toBeUndefined();
    expect(apps[0].verify.build).toBeUndefined();
    expect(apps[0].verify.typecheck).toBe("tsc --noEmit");
  });

  it("does not write the verify key when empty (terse output)", () => {
    const apps: App[] = [{
      name: "app-web",
      path: "/abs/app-web",
      rawPath: "../app-web",
      description: "",
      git: { branchMode: "current", fixedBranch: "", autoCommit: false, autoPush: false, worktreeMode: "disabled", mergeTargetBranch: "", integrationMode: "none" },
      pinnedFiles: [],
      symbolDirs: [],
      verify: {},
      quality: {},
    }];
    const out = serializeApps(apps);
    expect(out).not.toContain("verify");
    expect(out).toContain("app-web");
  });

  it("writes only the set verify fields", () => {
    const apps: App[] = [{
      name: "app-web",
      path: "/abs/app-web",
      rawPath: "../app-web",
      description: "",
      git: { branchMode: "current", fixedBranch: "", autoCommit: false, autoPush: false, worktreeMode: "disabled", mergeTargetBranch: "", integrationMode: "none" },
      pinnedFiles: [],
      symbolDirs: [],
      verify: { test: "bun test", typecheck: "tsc --noEmit" },
      quality: {},
    }];
    const parsed = JSON.parse(serializeApps(apps)) as {
      apps: Array<{ verify?: Record<string, string> }>;
    };
    expect(parsed.apps[0].verify).toEqual({
      test: "bun test",
      typecheck: "tsc --noEmit",
    });
  });

  it("round-trip preserves verify across serialize → parse", () => {
    const before: App[] = [{
      name: "app-api",
      path: "/abs/app-api",
      rawPath: "../app-api",
      description: "API",
      git: { branchMode: "current", fixedBranch: "", autoCommit: false, autoPush: false, worktreeMode: "disabled", mergeTargetBranch: "", integrationMode: "none" },
      pinnedFiles: [],
      symbolDirs: [],
      verify: { test: "bun test --reporter=verbose", lint: "eslint src/" },
      quality: {},
    }];
    const after = parseApps(serializeApps(before));
    expect(after[0].verify).toEqual(before[0].verify);
  });
});
