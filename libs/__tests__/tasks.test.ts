import { describe, it, expect } from "vitest";
import { generateTaskId, isValidTaskId } from "../tasks";

describe("generateTaskId", () => {
  it("returns t_YYYYMMDD_NNN incrementing from existing IDs for the same day", () => {
    const existing = ["t_20260424_001", "t_20260424_002", "t_20260423_005"];
    expect(generateTaskId(new Date("2026-04-24T10:00:00Z"), existing)).toBe("t_20260424_003");
    expect(generateTaskId(new Date("2026-04-25T10:00:00Z"), existing)).toBe("t_20260425_001");
  });
});

describe("isValidTaskId", () => {
  it("accepts the canonical generated format", () => {
    expect(isValidTaskId("t_20260425_001")).toBe(true);
    expect(isValidTaskId("t_20991231_999")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidTaskId("../../etc/passwd")).toBe(false);
    expect(isValidTaskId("..")).toBe(false);
    expect(isValidTaskId("../t_20260425_001")).toBe(false);
    expect(isValidTaskId("t_20260425_001/../..")).toBe(false);
  });

  it("rejects path separators and drive letters", () => {
    expect(isValidTaskId("t_20260425_001/extra")).toBe(false);
    expect(isValidTaskId("t_20260425\\001")).toBe(false);
    expect(isValidTaskId("C:t_20260425_001")).toBe(false);
  });

  it("rejects null bytes and whitespace", () => {
    expect(isValidTaskId("t_20260425_001\0")).toBe(false);
    expect(isValidTaskId(" t_20260425_001")).toBe(false);
    expect(isValidTaskId("t_20260425_001 ")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(isValidTaskId("")).toBe(false);
    expect(isValidTaskId("t_2026_001")).toBe(false);          // wrong date width
    expect(isValidTaskId("t_20260425_1")).toBe(false);         // counter not padded
    expect(isValidTaskId("T_20260425_001")).toBe(false);       // uppercase prefix
    expect(isValidTaskId("t-20260425-001")).toBe(false);       // hyphens not underscores
  });

  it("rejects non-strings", () => {
    expect(isValidTaskId(undefined)).toBe(false);
    expect(isValidTaskId(null)).toBe(false);
    expect(isValidTaskId(123)).toBe(false);
    expect(isValidTaskId({})).toBe(false);
  });
});
