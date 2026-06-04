import { describe, it, expect, beforeEach } from "vitest";
import { touchPresence, listActive, PRESENCE_TTL_MS, _clearForTests } from "../presenceStore";

const TASK = "t_20260604_001";

beforeEach(() => _clearForTests());

describe("presenceStore", () => {
  it("upserts by id (no duplicates) and stamps lastSeen", () => {
    touchPresence(TASK, { id: "operator", label: "Operator", kind: "operator" }, 1000);
    touchPresence(TASK, { id: "operator", label: "Operator", kind: "operator" }, 2000);
    const active = listActive(TASK, 2000);
    expect(active).toHaveLength(1);
    expect(active[0].lastSeen).toBe(2000);
  });

  it("lists operator first, then guests by label", () => {
    touchPresence(TASK, { id: "gdv_b", label: "Bob", kind: "guest" }, 1000);
    touchPresence(TASK, { id: "gdv_a", label: "Alice", kind: "guest" }, 1000);
    touchPresence(TASK, { id: "operator", label: "Operator", kind: "operator" }, 1000);
    const active = listActive(TASK, 1000);
    expect(active.map((p) => p.label)).toEqual(["Operator", "Alice", "Bob"]);
  });

  it("drops participants past the TTL", () => {
    touchPresence(TASK, { id: "gdv_a", label: "Alice", kind: "guest" }, 1000);
    touchPresence(TASK, { id: "gdv_b", label: "Bob", kind: "guest" }, 1000 + PRESENCE_TTL_MS);
    // now = 1001 + TTL → cutoff 1001: Alice (1000) is stale, Bob (1000+TTL) is fresh.
    const active = listActive(TASK, 1000 + PRESENCE_TTL_MS + 1);
    expect(active.map((p) => p.label)).toEqual(["Bob"]);
  });

  it("returns [] for an unknown task and after all expire", () => {
    expect(listActive("t_unknown")).toEqual([]);
    touchPresence(TASK, { id: "gdv_a", label: "Alice", kind: "guest" }, 1000);
    expect(listActive(TASK, 1000 + PRESENCE_TTL_MS + 1)).toEqual([]);
  });

  it("sanitizes labels (strips control chars, caps length, anonymizes empty)", () => {
    touchPresence(TASK, { id: "gdv_a", label: "A".repeat(80), kind: "guest" }, 1000);
    touchPresence(TASK, { id: "gdv_b", label: "   ", kind: "guest" }, 1000);
    const active = listActive(TASK, 1000);
    const a = active.find((p) => p.id === "gdv_a")!;
    const b = active.find((p) => p.id === "gdv_b")!;
    expect(a.label.length).toBe(40);
    expect(b.label).toBe("(anonymous)");
  });
});
