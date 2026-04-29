import { describe, it, expect } from "vitest";
import { parseApps, serializeApps, type App } from "../apps";

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

describe("AppQuality serialize/parse", () => {
  it("does not write the quality key when empty (terse output)", () => {
    const json = serializeApps([baseApp({})]);
    expect(json).not.toContain("\"quality\"");
  });

  it("writes only flags set to literal true", () => {
    const json = serializeApps([baseApp({ quality: { critic: true } })]);
    const parsed = JSON.parse(json) as {
      apps: Array<{ quality?: Record<string, unknown> }>;
    };
    expect(parsed.apps[0].quality).toEqual({ critic: true });
  });

  it("round-trips both flags via serialize → parse", () => {
    const before = [
      baseApp({ quality: { critic: true, verifier: true } }),
    ];
    const after = parseApps(serializeApps(before));
    expect(after[0].quality).toEqual({ critic: true, verifier: true });
  });

  it("normalizes non-true values to off", () => {
    const apps = parseApps(
      JSON.stringify({
        version: 1,
        apps: [
          {
            name: "app-x",
            path: "../app-x",
            // critic should be dropped (non-true), verifier kept
            quality: { critic: 1, verifier: true, unknown: "noise" },
          },
        ],
      }),
    );
    expect(apps[0].quality).toEqual({ verifier: true });
  });

  it("preserves missing quality as empty object on round-trip", () => {
    const json = JSON.stringify({
      version: 1,
      apps: [{ name: "app-y", path: "../app-y" }],
    });
    const apps = parseApps(json);
    expect(apps[0].quality).toEqual({});
  });
});
