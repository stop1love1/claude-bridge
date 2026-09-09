import { describe, expect, it } from "vitest";
import { httpErrorMessage } from "../client/api";

/**
 * Every caller of `api.*` funnels failures into `toast("error", e.message)`, so
 * whatever this returns is literally what the operator reads. It used to be
 * `${status} ${rawBody}`, which put
 * `409 {"error":"\"planner\" is reserved by a built-in role"}` on screen — the
 * status code and the JSON wrapper are noise in front of the one sentence that
 * was written for a human.
 */
describe("httpErrorMessage", () => {
  it("unwraps the { error } envelope every bridge route answers with", () => {
    expect(
      httpErrorMessage(409, JSON.stringify({ error: '"planner" is reserved by a built-in role' })),
    ).toBe('"planner" is reserved by a built-in role');
  });

  it("appends a hint when the route supplies one", () => {
    expect(httpErrorMessage(400, JSON.stringify({ error: "bad token", hint: "run setup again" })))
      .toBe("bad token — run setup again");
  });

  it("falls back to `reason` when that is the only prose available", () => {
    // `/api/tasks/<id>/agents` answers 409 `{ error, reason }` for a reserved
    // repo, and 410 with a `reason` for a speculative loser.
    expect(httpErrorMessage(409, JSON.stringify({ reason: "repo reserved by another run" })))
      .toBe("repo reserved by another run");
  });

  it("keeps the status when the body is JSON with nothing readable in it", () => {
    expect(httpErrorMessage(500, JSON.stringify({ ok: false }))).toBe('500 {"ok":false}');
  });

  it("keeps the status for a plain-text body — a proxy or a stack trace", () => {
    expect(httpErrorMessage(502, "upstream timed out")).toBe("502 upstream timed out");
  });

  it("does not dump an HTML error page into a toast", () => {
    expect(httpErrorMessage(504, "<html><body><h1>504 Gateway Timeout</h1></body></html>")).toBe(
      "HTTP 504",
    );
  });

  it("says something useful for an empty body", () => {
    expect(httpErrorMessage(500, "")).toBe("HTTP 500");
    expect(httpErrorMessage(500, "   ")).toBe("HTTP 500");
  });

  it("ignores a non-object JSON body rather than showing 'null' or a digit", () => {
    expect(httpErrorMessage(400, "null")).toBe("400 null");
    expect(httpErrorMessage(400, "[1,2]")).toBe("400 [1,2]");
  });

  it("ignores an `error` field that is not a string", () => {
    expect(httpErrorMessage(400, JSON.stringify({ error: 42 }))).toBe('400 {"error":42}');
  });
});
