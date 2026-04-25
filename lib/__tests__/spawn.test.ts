import { describe, it, expect } from "vitest";
import { autoApproveEnv, buildCoordinatorArgs } from "../spawn";

describe("buildCoordinatorArgs", () => {
  it("pins the session-id and ends with -p (prompt is piped via stdin)", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_20260424_001", prompt: "Do the thing." },
      sessionId,
    );
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toBe(sessionId);
    expect(args[args.length - 1]).toBe("-p");
  });

  it("requests stream-json output so stdout carries token deltas", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
  });

  it("emits no model / effort / permission-mode flag when settings absent", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--permission-mode");
  });

  it("forwards valid settings as flags", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settings: { mode: "acceptEdits", effort: "high", model: "opus" },
      },
      "id",
    );
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("rejects invalid settings values silently", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        // @ts-expect-error — explicitly testing runtime rejection
        settings: { mode: "rm -rf /", effort: "ULTRA", model: "../etc/passwd" },
      },
      "id",
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--model");
  });
});

/**
 * CRIT-1 regression: the permission hook used to no-op unless the
 * spawner explicitly opted IN to bridge-mediated approval. The fix
 * inverts that — the hook contacts the bridge by default, and the
 * spawn path opts the child OUT only for `bypassPermissions` mode
 * (coordinator + auto-spawned children where there's no human at the
 * keyboard to click Allow). `autoApproveEnv` is the single source of
 * truth for that mapping; the spawn function spreads its result into
 * the child env.
 */
describe("autoApproveEnv (CRIT-1)", () => {
  it("returns BRIDGE_AUTO_APPROVE=1 only for bypassPermissions", () => {
    expect(autoApproveEnv({ mode: "bypassPermissions" })).toEqual({
      BRIDGE_AUTO_APPROVE: "1",
    });
  });

  it("returns empty for every interactive mode (popup must fire)", () => {
    expect(autoApproveEnv({ mode: "default" })).toEqual({});
    expect(autoApproveEnv({ mode: "acceptEdits" })).toEqual({});
    expect(autoApproveEnv({ mode: "plan" })).toEqual({});
    expect(autoApproveEnv({ mode: "auto" })).toEqual({});
    expect(autoApproveEnv({ mode: "dontAsk" })).toEqual({});
  });

  it("returns empty when settings or mode is absent", () => {
    expect(autoApproveEnv(undefined)).toEqual({});
    expect(autoApproveEnv({})).toEqual({});
  });
});
