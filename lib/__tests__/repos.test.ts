import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { DEFAULT_GIT_SETTINGS, DEFAULT_VERIFY, parseApps, serializeApps, type App } from "../apps";

describe("parseApps", () => {
  it("returns empty list when input is empty", () => {
    expect(parseApps("")).toEqual([]);
    expect(parseApps("   ")).toEqual([]);
  });

  it("returns empty list when JSON is malformed", () => {
    expect(parseApps("not json")).toEqual([]);
    expect(parseApps("{]")).toEqual([]);
  });

  it("returns empty list when apps key is missing or non-array", () => {
    expect(parseApps(JSON.stringify({}))).toEqual([]);
    expect(parseApps(JSON.stringify({ apps: "nope" }))).toEqual([]);
  });

  it("extracts apps from a manifest with Path + Description fields", () => {
    const md = JSON.stringify({
      version: 1,
      apps: [
        { name: "app-web", path: "../app-web", description: "Frontend Next.js dashboard" },
        { name: "app-api", path: "/abs/app-api", description: "Backend NestJS API" },
      ],
    });
    const apps = parseApps(md);
    expect(apps.length).toBe(2);
    // Sorted alphabetically by name.
    expect(apps[0].name).toBe("app-api");
    expect(apps[0].description).toBe("Backend NestJS API");
    expect(apps[1].name).toBe("app-web");
    expect(apps[1].rawPath).toBe("../app-web");
  });

  it("tolerates missing description", () => {
    const md = JSON.stringify({ apps: [{ name: "solo", path: "../solo" }] });
    const apps = parseApps(md);
    expect(apps).toHaveLength(1);
    expect(apps[0].description).toBe("");
  });

  it("rejects entries whose name is not a valid app slug", () => {
    const md = JSON.stringify({
      apps: [{ name: "../etc/passwd", path: "../etc/passwd" }],
    });
    expect(parseApps(md)).toEqual([]);
  });

  it("rejects entries without a path", () => {
    const md = JSON.stringify({ apps: [{ name: "ghost" }] });
    expect(parseApps(md)).toEqual([]);
  });
});

describe("serializeApps + round-trip", () => {
  it("round-trips through serialize → parse", () => {
    // Use a relative rawPath so the platform-specific `resolve` in
    // parseApps lands on the same value on POSIX and Windows (it
    // resolves against BRIDGE_ROOT, which is `process.cwd()` here).
    const apps: App[] = [
      {
        name: "app-api",
        path: resolve(process.cwd(), "../app-api"),
        rawPath: "../app-api",
        description: "API",
        git: { ...DEFAULT_GIT_SETTINGS },
        verify: { ...DEFAULT_VERIFY },
        pinnedFiles: [],
        symbolDirs: [],
        quality: {},
        capabilities: [],
        retry: {},
      },
      {
        name: "app-web",
        path: resolve(process.cwd(), "../app-web"),
        rawPath: "../app-web",
        description: "Web",
        git: { ...DEFAULT_GIT_SETTINGS },
        verify: { ...DEFAULT_VERIFY },
        pinnedFiles: [],
        symbolDirs: [],
        quality: {},
        capabilities: [],
        retry: {},
      },
    ];
    const json = serializeApps(apps);
    const parsedManifest = JSON.parse(json) as { version: number; apps: Array<{ name: string; path: string }> };
    expect(parsedManifest.version).toBe(1);
    expect(parsedManifest.apps.map((a) => a.name)).toEqual(["app-api", "app-web"]);
    const parsed = parseApps(json);
    expect(parsed).toEqual(apps);
  });

  it("omits description field when description is empty", () => {
    const json = serializeApps([
      {
        name: "app-web",
        path: "/abs",
        rawPath: "../app-web",
        description: "   ",
        git: { ...DEFAULT_GIT_SETTINGS },
        verify: { ...DEFAULT_VERIFY },
        pinnedFiles: [],
        symbolDirs: [],
        quality: {},
        capabilities: [],
        retry: {},
      },
    ]);
    const parsed = JSON.parse(json) as { apps: Array<Record<string, unknown>> };
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0].name).toBe("app-web");
    expect(parsed.apps[0].path).toBe("../app-web");
    expect(parsed.apps[0]).not.toHaveProperty("description");
    // Default git settings should be omitted from the serialized blob
    // so existing bridge.json files stay untouched on round-trip.
    expect(parsed.apps[0]).not.toHaveProperty("git");
  });

  it("round-trips non-default git settings", () => {
    const apps: App[] = [
      {
        name: "feature-svc",
        path: resolve(process.cwd(), "../feature-svc"),
        rawPath: "../feature-svc",
        description: "",
        git: {
          branchMode: "fixed",
          fixedBranch: "develop",
          autoCommit: true,
          autoPush: true,
          worktreeMode: "disabled",
          mergeTargetBranch: "",
          integrationMode: "none",
        },
        verify: { ...DEFAULT_VERIFY },
        pinnedFiles: [],
        symbolDirs: [],
        quality: {},
        capabilities: [],
        retry: {},
      },
    ];
    const json = serializeApps(apps);
    const parsedManifest = JSON.parse(json) as {
      apps: Array<{ git?: { branchMode?: string; fixedBranch?: string; autoCommit?: boolean; autoPush?: boolean } }>;
    };
    expect(parsedManifest.apps[0].git).toEqual({
      branchMode: "fixed",
      fixedBranch: "develop",
      autoCommit: true,
      autoPush: true,
    });
    const parsed = parseApps(json);
    expect(parsed[0].git).toEqual(apps[0].git);
  });

  it("round-trips mergeTargetBranch and infers autoCommit from it", () => {
    // Operator wants auto-merge into `main`. autoCommit must be promoted
    // automatically (you can't merge an uncommitted work branch).
    const apps: App[] = [
      {
        name: "release-svc",
        path: resolve(process.cwd(), "../release-svc"),
        rawPath: "../release-svc",
        description: "",
        git: {
          branchMode: "auto-create",
          fixedBranch: "",
          autoCommit: true,
          autoPush: false,
          worktreeMode: "disabled",
          mergeTargetBranch: "main",
          integrationMode: "auto-merge",
        },
        verify: { ...DEFAULT_VERIFY },
        pinnedFiles: [],
        symbolDirs: [],
        quality: {},
        capabilities: [],
        retry: {},
      },
    ];
    const json = serializeApps(apps);
    const parsed = parseApps(json);
    expect(parsed[0].git.mergeTargetBranch).toBe("main");
    expect(parsed[0].git.autoCommit).toBe(true);
    expect(parsed[0].git.integrationMode).toBe("auto-merge");
    // Legacy: a manifest with `mergeTargetBranch` but no `integrationMode`
    // (older bridge releases) is auto-promoted to `auto-merge` so the
    // operator's prior behavior carries forward across upgrades.
    const fromLegacy = parseApps(JSON.stringify({
      version: 1,
      apps: [{
        name: "alt",
        path: "../alt",
        git: { branchMode: "auto-create", mergeTargetBranch: "develop" },
      }],
    }));
    expect(fromLegacy[0].git.autoCommit).toBe(true);
    expect(fromLegacy[0].git.mergeTargetBranch).toBe("develop");
    expect(fromLegacy[0].git.integrationMode).toBe("auto-merge");
  });

  it("round-trips integrationMode=pull-request and forces autoPush", () => {
    // pull-request mode requires the head branch on the remote, so the
    // normalize layer pins autoPush=true regardless of input.
    const fromManifest = parseApps(JSON.stringify({
      version: 1,
      apps: [{
        name: "pr-svc",
        path: "../pr-svc",
        git: {
          branchMode: "auto-create",
          mergeTargetBranch: "main",
          integrationMode: "pull-request",
          // Note: autoPush deliberately omitted — normalize must promote.
        },
      }],
    }));
    expect(fromManifest[0].git.integrationMode).toBe("pull-request");
    expect(fromManifest[0].git.autoCommit).toBe(true);
    expect(fromManifest[0].git.autoPush).toBe(true);
    expect(fromManifest[0].git.mergeTargetBranch).toBe("main");
    // Round-trip through serialize: terse output keeps the mode, drops
    // defaults.
    const json = serializeApps(fromManifest);
    const reparsed = parseApps(json);
    expect(reparsed[0].git.integrationMode).toBe("pull-request");
    expect(reparsed[0].git.autoPush).toBe(true);
  });

  it("demotes integrationMode to none when mergeTargetBranch is empty", () => {
    // Malformed config (mode set but target empty) is normalized to
    // `none` so the coordinator never tries to integrate against ''.
    const parsed = parseApps(JSON.stringify({
      version: 1,
      apps: [{
        name: "broken",
        path: "../broken",
        git: { integrationMode: "auto-merge", mergeTargetBranch: "" },
      }],
    }));
    expect(parsed[0].git.integrationMode).toBe("none");
  });
});
