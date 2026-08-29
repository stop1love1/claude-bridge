import { describe, expect, it } from "vitest";
import { parseFileRef } from "../../app/_components/SessionLog/fileRef";

describe("parseFileRef", () => {
  it("reads a repo-relative path with a line anchor", () => {
    expect(parseFileRef("libs/validate.ts#L81")).toEqual({
      path: "libs/validate.ts",
      line: 81,
    });
  });

  it("takes the first line of a range", () => {
    expect(parseFileRef("app/page.tsx#L42-L51")).toEqual({
      path: "app/page.tsx",
      line: 42,
    });
  });

  it("reads a path with no anchor", () => {
    expect(parseFileRef("BRIDGE.md")).toEqual({ path: "BRIDGE.md" });
  });

  it("handles the bracketed segments Next.js route files use", () => {
    expect(parseFileRef("app/api/sessions/[sessionId]/route.ts#L12")).toEqual({
      path: "app/api/sessions/[sessionId]/route.ts",
      line: 12,
    });
  });

  it("accepts a directory reference", () => {
    expect(parseFileRef("libs/client/")).toEqual({ path: "libs/client/" });
  });

  it("refuses anything that leaves the repo", () => {
    expect(parseFileRef("../secrets.env")).toBeNull();
    expect(parseFileRef("/etc/passwd")).toBeNull();
    expect(parseFileRef("libs/../../x.ts")).toBeNull();
  });

  it("refuses schemes, so an external or script link never reaches the viewer", () => {
    expect(parseFileRef("https://example.com/a.ts")).toBeNull();
    expect(parseFileRef("mailto:someone@example.com")).toBeNull();
    expect(parseFileRef("javascript:alert(1)")).toBeNull();
    expect(parseFileRef("//evil.com/x.ts")).toBeNull();
  });

  it("refuses empty, anchor-only and query-bearing hrefs", () => {
    expect(parseFileRef("")).toBeNull();
    expect(parseFileRef("#L10")).toBeNull();
    expect(parseFileRef("libs/a.ts?x=1")).toBeNull();
  });

  it("ignores a line anchor that is not a positive number", () => {
    expect(parseFileRef("libs/a.ts#L0")).toEqual({ path: "libs/a.ts" });
    expect(parseFileRef("libs/a.ts#section")).toEqual({ path: "libs/a.ts" });
  });
});
