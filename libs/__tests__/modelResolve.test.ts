import { describe, expect, it } from "vitest";
import { resolveModelForContinuation, resolveModelForRun } from "../modelResolve";

describe("resolveModelForRun", () => {
  it("returns undefined when nothing pins a model — the pre-pinning default", () => {
    expect(resolveModelForRun({ role: "coder" })).toBeUndefined();
    expect(
      resolveModelForRun({ role: "coder", app: { roleModels: {} }, taskModel: null }),
    ).toBeUndefined();
    expect(resolveModelForRun({ role: "coder", app: null, requested: undefined })).toBeUndefined();
  });

  it("prefers the per-dispatch request over every configured source", () => {
    expect(
      resolveModelForRun({
        requested: "haiku",
        app: { roleModels: { coder: "opus", "*": "sonnet" } },
        role: "coder",
        taskModel: "fable",
      }),
    ).toBe("haiku");
  });

  it("falls back to the app's per-role pin", () => {
    expect(
      resolveModelForRun({
        app: { roleModels: { coder: "opus", "*": "sonnet" } },
        role: "coder",
        taskModel: "fable",
      }),
    ).toBe("opus");
  });

  it("matches the per-role pin on the base role, so coder-api inherits coder", () => {
    const app = { roleModels: { coder: "opus" } };
    expect(resolveModelForRun({ app, role: "coder-api" })).toBe("opus");
    expect(resolveModelForRun({ app, role: "coder-phase24" })).toBe("opus");
    expect(resolveModelForRun({ app, role: "reviewer" })).toBeUndefined();
  });

  it("falls back to the app's wildcard when the role has no pin of its own", () => {
    expect(
      resolveModelForRun({
        app: { roleModels: { coder: "opus", "*": "sonnet" } },
        role: "reviewer",
        taskModel: "fable",
      }),
    ).toBe("sonnet");
  });

  it("falls back to the task pin when the app configures nothing", () => {
    expect(resolveModelForRun({ app: null, role: "coder", taskModel: "fable" })).toBe("fable");
    expect(
      resolveModelForRun({ app: { roleModels: {} }, role: "coder", taskModel: "fable" }),
    ).toBe("fable");
  });

  it("skips an invalid value at one level instead of throwing or short-circuiting", () => {
    // A bad `requested` must not swallow the app pin behind it.
    expect(
      resolveModelForRun({
        requested: "opus; rm -rf /",
        app: { roleModels: { coder: "opus" } },
        role: "coder",
      }),
    ).toBe("opus");
    // A bad per-role pin falls through to the wildcard, then to the task pin.
    expect(
      resolveModelForRun({
        app: { roleModels: { coder: "../etc/passwd", "*": "sonnet" } },
        role: "coder",
      }),
    ).toBe("sonnet");
    expect(
      resolveModelForRun({
        app: { roleModels: { coder: "", "*": " " } },
        role: "coder",
        taskModel: "fable",
      }),
    ).toBe("fable");
    // And a bad value everywhere still means "no --model".
    expect(
      resolveModelForRun({
        requested: "a b",
        app: { roleModels: { coder: "a b" } },
        role: "coder",
        taskModel: "a b",
      }),
    ).toBeUndefined();
  });

  it("treats an unregistered role as having no per-role pin but honours the wildcard", () => {
    expect(
      resolveModelForRun({
        app: { roleModels: { "*": "sonnet" } },
        role: "some-role-nobody-registered",
      }),
    ).toBe("sonnet");
  });
});

describe("resolveModelForContinuation", () => {
  it("re-pins the model the session was spawned with", () => {
    expect(
      resolveModelForContinuation({ role: "coder", priorModel: "claude-opus-5" }),
    ).toBe("claude-opus-5");
  });

  it("lets this call name a different model", () => {
    expect(
      resolveModelForContinuation({
        role: "coder",
        requested: "claude-sonnet-5",
        priorModel: "claude-opus-5",
      }),
    ).toBe("claude-sonnet-5");
  });

  it("keeps inheriting when the caller simply names nothing — every automatic retry", () => {
    // The bug this guards: if "no request" also meant "unpin", a gate retry
    // would finish a half-written diff on a different model.
    for (const requested of [undefined, null]) {
      expect(
        resolveModelForContinuation({ role: "coder", requested, priorModel: "claude-opus-5" }),
      ).toBe("claude-opus-5");
    }
    expect(
      resolveModelForContinuation({
        role: "coder",
        priorModel: "claude-opus-5",
        clearModel: false,
      }),
    ).toBe("claude-opus-5");
  });

  it("drops the session pin when clearModel is set, and then passes no model", () => {
    expect(
      resolveModelForContinuation({
        role: "coder",
        priorModel: "claude-opus-5",
        clearModel: true,
      }),
    ).toBeUndefined();
  });

  it("clearModel drops only the session pin — a standing app or task pin still applies", () => {
    // Same meaning "Default" has in the new-task dialog: no pin at *this*
    // level. Removing a task pin is an edit to the task, not a resume.
    expect(
      resolveModelForContinuation({
        role: "coder",
        priorModel: "claude-opus-5",
        taskModel: "claude-haiku-4-5",
        clearModel: true,
      }),
    ).toBe("claude-haiku-4-5");
    expect(
      resolveModelForContinuation({
        role: "coder",
        priorModel: "claude-opus-5",
        app: { roleModels: { coder: "claude-sonnet-5" } },
        clearModel: true,
      }),
    ).toBe("claude-sonnet-5");
  });

  it("an explicit model still beats clearModel — the two are not contradictory inputs", () => {
    expect(
      resolveModelForContinuation({
        role: "coder",
        requested: "claude-sonnet-5",
        priorModel: "claude-opus-5",
        clearModel: true,
      }),
    ).toBe("claude-sonnet-5");
  });

  it("ignores a prior model that would not survive the argv guard", () => {
    expect(
      resolveModelForContinuation({ role: "coder", priorModel: "opus 5" }),
    ).toBeUndefined();
  });
});
