import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Next's `app-render/async-local-storage` module snapshots
// `globalThis.AsyncLocalStorage` **once**, at evaluation time, and silently
// falls back to a FakeAsyncLocalStorage whose `run`/`exit` throw
// "Invariant: AsyncLocalStorage accessed in runtime where it is not available".
// Next installs that global from `node-environment-baseline`, but for a custom
// server that only happens inside `app.prepare()` — long after our own imports
// have been evaluated. Any module reaching `next/server` before then (e.g.
// libs/validate.ts -> NextResponse) poisons the store, and the first console.*
// call after Next's console-exit extension loads kills the process.
//
// scripts/nodeEnvironmentBootstrap.ts closes that window. These tests pin both
// halves: that the hazard is real, and that the entry still imports the guard
// before anything else.

const ROOT = join(__dirname, "..", "..");
const ENTRY = join(ROOT, "scripts", "bridge-http-server.ts");
const BOOTSTRAP = join(ROOT, "scripts", "nodeEnvironmentBootstrap.ts");
const APPS = join(ROOT, "libs", "apps.ts");
const NEXT_ALS = join(
  ROOT,
  "node_modules",
  "next",
  "dist",
  "server",
  "app-render",
  "async-local-storage.js",
);

/**
 * Load `prelude` in a fresh Node process (same tsx setup as `npm run dev`),
 * then report whether Next's app-render store came out real or faked.
 */
function alsKindAfterLoading(prelude: string[]): string {
  const src = [
    ...prelude.map((m) => `require(${JSON.stringify(m)});`),
    `const { AsyncLocalStorage } = require("node:async_hooks");`,
    `const store = require(${JSON.stringify(NEXT_ALS)}).createAsyncLocalStorage();`,
    `process.stdout.write(store instanceof AsyncLocalStorage ? "real" : "fake");`,
  ].join("\n");
  return execFileSync(process.execPath, ["--import", "tsx", "-e", src], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("custom server node environment bootstrap", () => {
  it("still needs a guard: reaching next/server first leaves a fake store", { timeout: 120_000 }, () => {
    expect(alsKindAfterLoading([APPS])).toBe("fake");
  });

  it("gives Next a real AsyncLocalStorage when the bootstrap is loaded first", { timeout: 120_000 }, () => {
    expect(alsKindAfterLoading([BOOTSTRAP, APPS])).toBe("real");
  });

  it("keeps the bootstrap as the first import of the server entry", () => {
    const imports = readFileSync(ENTRY, "utf8").match(/^import[^\n]*$/gm) ?? [];
    expect(imports[0]).toMatch(/nodeEnvironmentBootstrap/);
  });
});
