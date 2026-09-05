import { describe, it, expect } from "vitest";
import { parseApps, serializeApps, type App } from "../apps";
import { resolveModelForRun } from "../modelResolve";

const baseApp = (overrides: Partial<App>): App => ({
  name: "app-web",
  path: "/abs/app-web",
  rawPath: "../app-web",
  description: "",
  git: {
    branchMode: "current",
    fixedBranch: "",
    autoCommit: false,
    autoPush: false,
    worktreeMode: "disabled",
    mergeTargetBranch: "",
    integrationMode: "none",
  },
  verify: {},
  pinnedFiles: [],
  symbolDirs: [],
  quality: {},
  capabilities: [],
  retry: {},
  memory: {},
  dispatch: {},
  ...overrides,
});

const manifest = (appEntry: Record<string, unknown>) =>
  JSON.stringify({ version: 1, apps: [{ name: "app-web", path: "../app-web", ...appEntry }] });

describe("roleModels serialize/parse", () => {
  it("writes no roleModels key when there are no pins — an untouched bridge.json stays untouched", () => {
    expect(serializeApps([baseApp({})])).not.toContain("roleModels");
    expect(serializeApps([baseApp({ roleModels: {} })])).not.toContain("roleModels");
  });

  it("round-trips role and wildcard pins", () => {
    const json = serializeApps([baseApp({ roleModels: { coder: "opus", "*": "sonnet" } })]);
    expect(parseApps(json)[0].roleModels).toEqual({ coder: "opus", "*": "sonnet" });
  });

  it("reads an app that predates the field as having no pins", () => {
    expect(parseApps(manifest({}))[0].roleModels).toBeUndefined();
  });

  it("drops entries whose model would be rejected at spawn time", () => {
    const apps = parseApps(
      manifest({
        roleModels: {
          coder: "opus",
          reviewer: "--dangerously-skip-permissions",
          planner: "../etc/passwd",
          devops: "opus 5",
          "style-critic": 42,
        },
      }),
    );
    expect(apps[0].roleModels).toEqual({ coder: "opus" });
  });

  it("drops keys that are not a role label or the wildcard", () => {
    const apps = parseApps(
      manifest({ roleModels: { "coder; rm -rf /": "opus", "*": "sonnet" } }),
    );
    expect(apps[0].roleModels).toEqual({ "*": "sonnet" });
  });

  it("ignores a roleModels value that is not an object", () => {
    expect(parseApps(manifest({ roleModels: ["opus"] }))[0].roleModels).toBeUndefined();
    expect(parseApps(manifest({ roleModels: "opus" }))[0].roleModels).toBeUndefined();
    expect(parseApps(manifest({ roleModels: null }))[0].roleModels).toBeUndefined();
  });
});

describe("a parsed app feeds resolveModelForRun directly", () => {
  it("an app with no pins resolves to undefined for every role", () => {
    const app = parseApps(manifest({}))[0];
    for (const role of ["coder", "reviewer", "coordinator", "coder-api"]) {
      expect(resolveModelForRun({ app, role })).toBeUndefined();
    }
  });

  it("a labelled child inherits its base role's pin", () => {
    const app = parseApps(manifest({ roleModels: { coder: "opus", "*": "sonnet" } }))[0];
    expect(resolveModelForRun({ app, role: "coder-api" })).toBe("opus");
    expect(resolveModelForRun({ app, role: "reviewer-2" })).toBe("sonnet");
  });
});
