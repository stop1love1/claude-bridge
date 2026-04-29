import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeErrorMessage, scrubPaths, serverError } from "../errorResponse";

describe("scrubPaths", () => {
  it("masks quoted POSIX absolute paths", () => {
    const msg = "ENOENT: no such file or directory, open '/home/u/secret/meta.json'";
    expect(scrubPaths(msg)).toBe(
      "ENOENT: no such file or directory, open '<path>'",
    );
  });

  it("masks quoted Windows absolute paths", () => {
    const msg = "ENOENT: no such file or directory, open 'D:\\Edusoft\\claude-bridge\\sessions\\t_001\\meta.json'";
    expect(scrubPaths(msg)).toBe(
      "ENOENT: no such file or directory, open '<path>'",
    );
  });

  it("masks Windows paths with forward slashes", () => {
    expect(scrubPaths("could not find 'D:/Edusoft/secrets.json'"))
      .toBe("could not find '<path>'");
  });

  it("masks bare POSIX paths", () => {
    expect(scrubPaths("git failed at /var/lib/foo/bar.git"))
      .toBe("git failed at <path>");
  });

  it("masks bare Windows paths", () => {
    expect(scrubPaths("error in C:\\Users\\op\\.claude\\bridge.json"))
      .toBe("error in <path>");
  });

  it("masks UNC paths", () => {
    expect(scrubPaths("read failed on \\\\server\\share\\file"))
      .toBe("read failed on <path>");
  });

  it("leaves messages without paths untouched", () => {
    expect(scrubPaths("permission denied")).toBe("permission denied");
    expect(scrubPaths("ENOENT")).toBe("ENOENT");
    expect(scrubPaths("")).toBe("");
  });

  it("is idempotent on already-scrubbed input", () => {
    const scrubbed = "open '<path>'";
    expect(scrubPaths(scrubbed)).toBe(scrubbed);
  });
});

describe("safeErrorMessage", () => {
  it("prefers a stable error code when present", () => {
    const err = new Error("some long message with /private/path") as Error & { code?: string };
    err.code = "ENOENT";
    expect(safeErrorMessage(err)).toBe("ENOENT");
  });

  it("ignores codes that don't match the stable shape", () => {
    const err = new Error("oops") as Error & { code?: string };
    err.code = "user-supplied junk";
    expect(safeErrorMessage(err)).toBe("oops");
  });

  it("returns the first line of an Error.message", () => {
    const err = new Error("first line\n    at someFn (foo.js:1:1)\n    at otherFn");
    expect(safeErrorMessage(err)).toBe("first line");
  });

  it("scrubs paths in the surfaced message", () => {
    const err = new Error("could not read 'D:/Edusoft/claude-bridge/secrets/api.key'");
    expect(safeErrorMessage(err)).toBe("could not read '<path>'");
  });

  it("scrubs plain-string errors too", () => {
    expect(safeErrorMessage("failed at /var/run/secret"))
      .toBe("failed at <path>");
  });

  it("falls back when input is null / undefined / non-error object", () => {
    expect(safeErrorMessage(null)).toBe("internal_error");
    expect(safeErrorMessage(undefined)).toBe("internal_error");
    expect(safeErrorMessage({})).toBe("internal_error");
    expect(safeErrorMessage(42)).toBe("internal_error");
  });

  it("honors a custom fallback for non-error inputs", () => {
    expect(safeErrorMessage(undefined, "spawn_failed")).toBe("spawn_failed");
  });

  it("caps very long messages", () => {
    const huge = "x".repeat(500);
    const out = safeErrorMessage(new Error(huge));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("serverError", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("returns a sanitized body and logs the full error to stderr", () => {
    const err = new Error("boom at /var/log/secret.log") as Error & { code?: string };
    err.code = "EACCES";
    const body = serverError(err, "sessions:create");
    expect(body).toEqual({ error: "EACCES" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const [, fullErr] = consoleSpy.mock.calls[0];
    expect(fullErr).toBe(err);
  });

  it("logs without a context tag when none is supplied", () => {
    const err = new Error("plain failure");
    const body = serverError(err);
    expect(body).toEqual({ error: "plain failure" });
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});
