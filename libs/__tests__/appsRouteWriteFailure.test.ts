import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  addThrows: null as unknown,
  addCalls: [] as string[],
}));

vi.mock("@/libs/apps", () => ({
  isValidAppName: (n: unknown) =>
    typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n),
  loadApps: () => [],
  addApp: (input: { name: string }) => {
    state.addCalls.push(input.name);
    if (state.addThrows) throw state.addThrows;
    return { ok: true, app: { name: input.name } };
  },
}));

vi.mock("@/libs/worktrees", () => ({
  pruneStaleWorktrees: async () => 0,
}));

import { POST } from "@/app/api/apps/route";
import { POST as BULK } from "@/app/api/apps/bulk/route";

function reqWith(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(
    `${code}: permission denied, open '/home/dev/.claude/bridge.json.941.tmp'`,
  ) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

beforeEach(() => {
  state.addThrows = null;
  state.addCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => { });
});

describe("POST /api/apps — a manifest write the OS refuses", () => {
  it("answers with an actionable body instead of throwing an opaque 500", async () => {
    state.addThrows = errnoError("EACCES");
    const res = await POST(reqWith({ name: "app-web", path: "/srv/app-web" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("EACCES");
    expect(body.error).toContain("~/.claude/bridge.json");
    expect(body.error).toContain("permission");
  });

  it("does the same for EPERM, EROFS and ENOSPC", async () => {
    for (const [code, needle] of [
      ["EPERM", "permission"],
      ["EROFS", "read-only"],
      ["ENOSPC", "full"],
    ] as const) {
      state.addThrows = errnoError(code);
      const res = await POST(reqWith({ name: "app-web", path: "/srv/app-web" }));
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(code);
      expect(body.error).toContain(needle);
    }
  });

  it("never puts an absolute host path in the response body", async () => {
    state.addThrows = errnoError("EACCES");
    const res = await POST(reqWith({ name: "app-web", path: "/srv/app-web" }));
    const body = (await res.json()) as { error: string; detail?: string };
    expect(JSON.stringify(body)).not.toContain("/home/dev");
  });

  it("still reports a non-filesystem crash as a 500 rather than throwing", async () => {
    state.addThrows = new TypeError("something else broke");
    const res = await POST(reqWith({ name: "app-web", path: "/srv/app-web" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("leaves the happy path untouched", async () => {
    const res = await POST(reqWith({ name: "app-web", path: "/srv/app-web" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "app-web" });
  });
});

describe("POST /api/apps/bulk — a manifest write the OS refuses", () => {
  it("reports the failure per item and stops, instead of throwing mid-batch", async () => {
    state.addThrows = errnoError("EACCES");
    const res = await BULK(
      reqWith({
        apps: [
          { name: "a", path: "/srv/a" },
          { name: "b", path: "/srv/b" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      added: unknown[];
      failed: { name: string; reason: string; detail?: string }[];
    };
    expect(body.added).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].name).toBe("a");
    expect(body.failed[0].reason).toBe("write-failed");
    expect(body.failed[0].detail).toContain("EACCES");
    // Every later write would fail identically — do not hammer the disk.
    expect(state.addCalls).toEqual(["a"]);
  });

  it("leaves the happy path untouched", async () => {
    const res = await BULK(
      reqWith({ apps: [{ name: "a", path: "/srv/a" }, { name: "b", path: "/srv/b" }] }),
    );
    const body = (await res.json()) as { added: unknown[]; failed: unknown[] };
    expect(body.added).toHaveLength(2);
    expect(body.failed).toEqual([]);
  });
});
