import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";

const TMP_CLAUDE = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-profilesource-"));
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, USER_CLAUDE_DIR: TMP_CLAUDE };
});

import { getManifestProfileSource, setManifestProfileSource } from "../bridgeSettings";
import { PUT, GET } from "@/app/api/profiles/settings/route";

const BRIDGE_JSON = join(TMP_CLAUDE, "bridge.json");

function writeManifest(extra: Record<string, unknown>): void {
  writeFileSync(
    BRIDGE_JSON,
    JSON.stringify({ version: 1, apps: [], ...extra }, null, 2) + "\n",
    "utf8",
  );
}

function readManifestFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(BRIDGE_JSON, "utf8")) as Record<string, unknown>;
}

/** The route only ever calls `req.json()`, so that is all a fixture needs. */
function reqWith(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function reqWithBadJson(): NextRequest {
  return {
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  if (existsSync(BRIDGE_JSON)) rmSync(BRIDGE_JSON, { force: true });
  writeManifest({});
});

describe("PUT /api/profiles/settings — body validation", () => {
  it("rejects a JSON body that is not an object with 400, never 500", async () => {
    // `null` used to reach `body.source` and throw a TypeError -> HTTP 500.
    for (const body of [null, [], ["llm"], 5, 0, "llm", "", true]) {
      const res = await PUT(reqWith(body));
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400);
      expect(await res.json()).toEqual({ error: "body must be a JSON object" });
    }
  });

  it("rejects unparseable JSON with 400", async () => {
    const res = await PUT(reqWithBadJson());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("rejects an object whose source is missing or unknown", async () => {
    for (const body of [{}, { source: "auto" }, { source: null }, { source: ["llm"] }]) {
      const res = await PUT(reqWith(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({
        error: "source must be one of: heuristic, llm",
      });
    }
  });

  it("accepts both valid sources and GET reflects the write", async () => {
    const on = await PUT(reqWith({ source: "llm" }));
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ source: "llm" });
    expect(await GET().json()).toEqual({ source: "llm" });

    const off = await PUT(reqWith({ source: "heuristic" }));
    expect(off.status).toBe(200);
    expect(await GET().json()).toEqual({ source: "heuristic" });
  });

  it("ignores extra keys in an otherwise valid body", async () => {
    const res = await PUT(reqWith({ source: "llm", nope: "ignored" }));
    expect(res.status).toBe(200);
    expect(readManifestFile().profiles).toEqual({ source: "llm" });
  });
});

describe("setManifestProfileSource", () => {
  it("defaults to heuristic and writes no key at all for the default", () => {
    expect(getManifestProfileSource()).toBe("heuristic");
    setManifestProfileSource("heuristic");
    expect(readManifestFile().profiles).toBeUndefined();
  });

  it("round-trips llm -> heuristic and leaves bridge.json byte-identical", () => {
    const before = readFileSync(BRIDGE_JSON, "utf8");
    setManifestProfileSource("llm");
    expect(readManifestFile().profiles).toEqual({ source: "llm" });
    setManifestProfileSource("heuristic");
    expect(readFileSync(BRIDGE_JSON, "utf8")).toBe(before);
  });

  it("keeps sibling keys under `profiles` when flipping back to the default", () => {
    writeManifest({ profiles: { retentionDays: 7, source: "llm" } });
    expect(getManifestProfileSource()).toBe("llm");

    setManifestProfileSource("heuristic");
    expect(readManifestFile().profiles).toEqual({ retentionDays: 7 });
    expect(getManifestProfileSource()).toBe("heuristic");

    setManifestProfileSource("llm");
    expect(readManifestFile().profiles).toEqual({ retentionDays: 7, source: "llm" });
  });

  it("survives a `profiles` value that is not an object", () => {
    writeManifest({ profiles: "nonsense" });
    expect(getManifestProfileSource()).toBe("heuristic");
    setManifestProfileSource("llm");
    expect(readManifestFile().profiles).toEqual({ source: "llm" });
  });

  it("leaves the detect section untouched", () => {
    writeManifest({ detect: { source: "llm", scanRoots: ["/tmp/scan-root"] } });
    setManifestProfileSource("llm");
    setManifestProfileSource("heuristic");
    expect(readManifestFile().detect).toEqual({
      source: "llm",
      scanRoots: ["/tmp/scan-root"],
    });
  });
});
