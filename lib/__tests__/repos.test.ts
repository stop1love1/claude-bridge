import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parseApps, serializeApps, type App } from "../apps";

describe("parseApps", () => {
  it("returns empty list when input is empty", () => {
    expect(parseApps("")).toEqual([]);
  });

  it("extracts apps from h2 sections with Path + Description fields", () => {
    const md = `# Apps

> intro

## app-web
- **Path:** \`../app-web\`
- **Description:** Frontend Next.js dashboard

## app-api
- **Path:** \`/abs/app-api\`
- **Description:** Backend NestJS API
`;
    const apps = parseApps(md);
    expect(apps.length).toBe(2);
    expect(apps[0].name).toBe("app-api");
    expect(apps[0].description).toBe("Backend NestJS API");
    expect(apps[1].name).toBe("app-web");
    expect(apps[1].rawPath).toBe("../app-web");
  });

  it("tolerates missing description", () => {
    const md = `## solo\n- **Path:** \`../solo\`\n`;
    const apps = parseApps(md);
    expect(apps).toHaveLength(1);
    expect(apps[0].description).toBe("");
  });

  it("rejects sections whose heading is not a valid app name", () => {
    const md = `## ../etc/passwd\n- **Path:** \`../etc/passwd\`\n`;
    expect(parseApps(md)).toEqual([]);
  });

  it("rejects sections without a Path field", () => {
    const md = `## ghost\n- **Description:** No path on this one\n`;
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
    const md = serializeApps(apps);
    expect(md).toContain("## app-api");
    expect(md).toContain("- **Path:** `../app-api`");
    const parsed = parseApps(md);
    expect(parsed).toEqual(apps);
  });

  it("omits Description line when description is empty", () => {
    const md = serializeApps([
      { name: "app-web", path: "/abs", rawPath: "../app-web", description: "   " },
    ]);
    expect(md).toContain("## app-web");
    expect(md).toContain("- **Path:** `../app-web`");
    expect(md).not.toContain("Description");
  });
});
