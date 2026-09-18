import { describe, expect, it } from "vitest";
import { shortId } from "../shortId";

describe("shortId", () => {
  it("returns a non-empty string", () => {
    expect(typeof shortId()).toBe("string");
    expect(shortId().length).toBeGreaterThan(0);
  });

  it("is URL-safe (no +, /, =)", () => {
    const id = shortId(8);
    expect(id).not.toMatch(/[+/=]/);
  });

  it("length scales with byte count", () => {
    // ~1.3 chars per byte for base64url
    expect(shortId(3).length).toBeGreaterThanOrEqual(3);
    expect(shortId(6).length).toBeGreaterThanOrEqual(6);
  });

  it("generates unique values", () => {
    const set = new Set(Array.from({ length: 100 }, () => shortId(4)));
    // With 4 bytes (~5 chars), 100 samples should all be unique
    expect(set.size).toBe(100);
  });
});
