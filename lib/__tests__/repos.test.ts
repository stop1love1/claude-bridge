import { describe, it, expect } from "bun:test";
import { parseReposTable, resolveRepos } from "../repos";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const fixture = readFileSync(join(__dirname, "fixtures/bridge.md"), "utf8");

describe("parseReposTable", () => {
  it("extracts folder names from the Repos table (single-column layout)", () => {
    const repos = parseReposTable(fixture);
    expect(repos).toEqual([
      { name: "app-web" },
      { name: "app-api" },
    ]);
  });

  it("throws if no Repos table present", () => {
    expect(() => parseReposTable("# Just a heading\n\nNo table.")).toThrow(/Repos table/);
  });

  it("supports any number of repos", () => {
    const md = `## Repos\n\n| Folder name |\n|---|\n| \`a\` |\n| \`b\` |\n| \`c\` |\n`;
    expect(parseReposTable(md)).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
  });
});

describe("resolveRepos", () => {
  it("resolves each folder as sibling of the bridge root", () => {
    const resolved = resolveRepos(fixture, "/parent/bridge");
    expect(resolved).toEqual([
      { name: "app-web", path: resolve("/parent/app-web") },
      { name: "app-api", path: resolve("/parent/app-api") },
    ]);
  });
});
