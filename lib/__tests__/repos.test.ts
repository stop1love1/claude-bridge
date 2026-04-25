import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parseApps, serializeApps, type App } from "../apps";

describe("parseApps", () => {
  it("returns empty list when input is empty", () => {
    expect(parseApps("")).toEqual([]);
    expect(parseApps("   ")).toEqual([]);
  });

  it("returns empty list when JSON is malformed", () => {
    expect(parseApps("not json")).toEqual([]);
    expect(parseApps("{]")).toEqual([]);
  });

  it("returns empty list when apps key is missing or non-array", () => {
    expect(parseApps(JSON.stringify({}))).toEqual([]);
    expect(parseApps(JSON.stringify({ apps: "nope" }))).toEqual([]);
  });

  it("extracts apps from a manifest with Path + Description fields", () => {
    const md = JSON.stringify({
      version: 1,
      apps: [
        { name: "app-web", path: "../app-web", description: "Frontend Next.js dashboard" },
        { name: "app-api", path: "/abs/app-api", description: "Backend NestJS API" },
      ],
    });
    const apps = parseApps(md);
    expect(apps.length).toBe(2);
    // Sorted alphabetically by name.
    expect(apps[0].name).toBe("app-api");
    expect(apps[0].description).toBe("Backend NestJS API");
    expect(apps[1].name).toBe("app-web");
    expect(apps[1].rawPath).toBe("../app-web");
  });

  it("tolerates missing description", () => {
    const md = JSON.stringify({ apps: [{ name: "solo", path: "../solo" }] });
    const apps = parseApps(md);
    expect(apps).toHaveLength(1);
    expect(apps[0].description).toBe("");
  });

  it("rejects entries whose name is not a valid app slug", () => {
    const md = JSON.stringify({
      apps: [{ name: "../etc/passwd", path: "../etc/passwd" }],
    });
    expect(parseApps(md)).toEqual([]);
  });

  it("rejects entries without a path", () => {
    const md = JSON.stringify({ apps: [{ name: "ghost" }] });
    expect(parseApps(md)).toEqual([]);
  });
});

describe("serializeApps + round-trip", () => {
  it("round-trips through serialize → parse", () => {
    // Use a relative rawPath so the platform-specific `resolve` in
    // parseApps lands on the same value on POSIX and Windows (it
    // resolves against BRIDGE_ROOT, which is `process.cwd()` here).
    const apps: App[] = [
      { name: "app-api", path: resolve(process.cwd(), "../app-api"), rawPath: "../app-api", description: "API" },
      { name: "app-web", path: resolve(process.cwd(), "../app-web"), rawPath: "../app-web", description: "Web" },
    ];
    const json = serializeApps(apps);
    const parsedManifest = JSON.parse(json) as { version: number; apps: Array<{ name: string; path: string }> };
    expect(parsedManifest.version).toBe(1);
    expect(parsedManifest.apps.map((a) => a.name)).toEqual(["app-api", "app-web"]);
    const parsed = parseApps(json);
    expect(parsed).toEqual(apps);
  });

  it("omits description field when description is empty", () => {
    const json = serializeApps([
      { name: "app-web", path: "/abs", rawPath: "../app-web", description: "   " },
    ]);
    const parsed = JSON.parse(json) as { apps: Array<Record<string, unknown>> };
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0].name).toBe("app-web");
    expect(parsed.apps[0].path).toBe("../app-web");
    expect(parsed.apps[0]).not.toHaveProperty("description");
  });
});
