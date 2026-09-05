import { describe, expect, it } from "vitest";
import { resolveModelForRun } from "../modelResolve";

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
