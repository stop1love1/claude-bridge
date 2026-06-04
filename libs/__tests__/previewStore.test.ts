import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  getPreviewUrl,
  setPreviewUrl,
  listPreviews,
  isValidPreviewUrl,
  _resetForTests,
  _internal,
} from "../previewStore";

const { PREVIEWS_FILE } = _internal;
let saved: string | null = null;

beforeEach(() => {
  saved = existsSync(PREVIEWS_FILE) ? readFileSync(PREVIEWS_FILE, "utf8") : null;
  if (existsSync(PREVIEWS_FILE)) rmSync(PREVIEWS_FILE, { force: true });
  _resetForTests();
});
afterEach(() => {
  if (saved !== null) writeFileSync(PREVIEWS_FILE, saved, "utf8");
  else if (existsSync(PREVIEWS_FILE)) rmSync(PREVIEWS_FILE, { force: true });
  _resetForTests();
});

describe("previewStore", () => {
  it("set + get round-trips a valid http(s) url", () => {
    setPreviewUrl("web", "http://localhost:3000");
    expect(getPreviewUrl("web")).toBe("http://localhost:3000");
    setPreviewUrl("api", "https://staging.example.com/app");
    expect(getPreviewUrl("api")).toBe("https://staging.example.com/app");
  });

  it("clears on empty", () => {
    setPreviewUrl("web", "http://localhost:3000");
    setPreviewUrl("web", "");
    expect(getPreviewUrl("web")).toBeNull();
  });

  it("rejects non-http(s) urls", () => {
    expect(() => setPreviewUrl("web", "javascript:alert(1)")).toThrow();
    expect(() => setPreviewUrl("web", "data:text/html,x")).toThrow();
    expect(() => setPreviewUrl("web", "ftp://x")).toThrow();
    expect(getPreviewUrl("web")).toBeNull();
  });

  it("isValidPreviewUrl gate", () => {
    expect(isValidPreviewUrl("https://x.com")).toBe(true);
    expect(isValidPreviewUrl("http://localhost:5173")).toBe(true);
    expect(isValidPreviewUrl("javascript:1")).toBe(false);
    expect(isValidPreviewUrl("/relative")).toBe(false);
  });

  it("listPreviews returns the name→url map", () => {
    setPreviewUrl("web", "http://localhost:3000");
    expect(listPreviews()).toEqual({ web: "http://localhost:3000" });
  });

  it("getPreviewUrl is null for an unknown app", () => {
    expect(getPreviewUrl("nope")).toBeNull();
  });
});
