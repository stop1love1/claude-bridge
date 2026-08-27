import { describe, it, expect } from "vitest";
import {
  parseApps,
  serializeApps,
  applyRecommendedPreset,
  RECOMMENDED_GIT_SETTINGS,
  DEFAULT_GIT_SETTINGS,
  type App,
} from "../apps";

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

describe("applyRecommendedPreset", () => {
  it("applies the recommended git settings and quality.critic to a default-settings app", () => {
    const app = baseApp({});
    const result = applyRecommendedPreset(app);
    expect(result.git).toEqual(RECOMMENDED_GIT_SETTINGS);
    expect(result.quality.critic).toBe(true);
  });

  it("leaves an operator-customized branchMode untouched but still fills in other default fields", () => {
    const app = baseApp({
      git: { ...DEFAULT_GIT_SETTINGS, branchMode: "fixed", fixedBranch: "main" },
    });
    const result = applyRecommendedPreset(app);
    expect(result.git.branchMode).toBe("fixed");
    expect(result.git.fixedBranch).toBe("main");
    expect(result.git.autoCommit).toBe(true);
    expect(result.git.autoPush).toBe(false);
    expect(result.git.worktreeMode).toBe("disabled");
    expect(result.git.mergeTargetBranch).toBe("");
    expect(result.git.integrationMode).toBe("none");
    expect(result.quality.critic).toBe(true);
  });

  it("does not mutate the input app", () => {
    const app = baseApp({});
    applyRecommendedPreset(app);
    expect(app.git).toEqual(DEFAULT_GIT_SETTINGS);
    expect(app.quality).toEqual({});
  });

  it("preserves other quality flags already set on the app", () => {
    const app = baseApp({ quality: { verifier: true, criticPanel: 2 } });
    const result = applyRecommendedPreset(app);
    expect(result.quality).toEqual({ verifier: true, criticPanel: 2, critic: true });
  });
});
