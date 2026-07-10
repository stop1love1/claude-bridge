import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detectVerifyCommands } from "../verifyDetect";
import { mktmp } from "./helpers/fs";

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    const dir = abs.replace(/[\\/][^\\/]+$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

describe("detectVerifyCommands", () => {
  let dir: string;

  beforeEach(() => {
    dir = mktmp("verifydetect");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns {} for an empty directory", () => {
    expect(detectVerifyCommands(dir)).toEqual({});
  });

  it("maps package.json scripts using npm by default", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({
        name: "app",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
          build: "next build",
          typecheck: "tsc --noEmit",
        },
      }),
    });
    expect(detectVerifyCommands(dir)).toEqual({
      test: "npm run test",
      lint: "npm run lint",
      build: "npm run build",
      typecheck: "npm run typecheck",
    });
  });

  it("uses bun when bun.lock is present", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bun.lock": "",
    });
    expect(detectVerifyCommands(dir).test).toBe("bun run test");
  });

  it("uses bun when bun.lockb is present", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bun.lockb": "",
    });
    expect(detectVerifyCommands(dir).test).toBe("bun run test");
  });

  it("uses pnpm when pnpm-lock.yaml is present", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { build: "next build" } }),
      "pnpm-lock.yaml": "",
    });
    expect(detectVerifyCommands(dir).build).toBe("pnpm run build");
  });

  it("uses yarn when yarn.lock is present", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "yarn.lock": "",
    });
    expect(detectVerifyCommands(dir).lint).toBe("yarn run lint");
  });

  it("maps a `tsc` script name to typecheck", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { tsc: "tsc --noEmit" } }),
    });
    expect(detectVerifyCommands(dir).typecheck).toBe("npm run tsc");
  });

  it("maps a `type-check` script name to typecheck", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { "type-check": "tsc --noEmit" } }),
    });
    expect(detectVerifyCommands(dir).typecheck).toBe("npm run type-check");
  });

  it("maps a `check-types` script name to typecheck", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { "check-types": "tsc --noEmit" } }),
    });
    expect(detectVerifyCommands(dir).typecheck).toBe("npm run check-types");
  });

  it("prefers an explicit `typecheck` script over aliases", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({
        scripts: { typecheck: "tsc --noEmit", tsc: "tsc --version" },
      }),
    });
    expect(detectVerifyCommands(dir).typecheck).toBe("npm run typecheck");
  });

  it("maps a `fmt` script name to format", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { fmt: "prettier --write ." } }),
    });
    expect(detectVerifyCommands(dir).format).toBe("npm run fmt");
  });

  it("maps an explicit `format` script name to format", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({ scripts: { format: "prettier --write ." } }),
    });
    expect(detectVerifyCommands(dir).format).toBe("npm run format");
  });

  it("skips the npm default placeholder test script", () => {
    writeFiles(dir, {
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    });
    expect(detectVerifyCommands(dir).test).toBeUndefined();
  });

  it("skips a corrupt package.json without throwing", () => {
    writeFiles(dir, {
      "package.json": "{ not valid json ",
    });
    expect(() => detectVerifyCommands(dir)).not.toThrow();
    expect(detectVerifyCommands(dir)).toEqual({});
  });

  it("detects Go projects via go.mod", () => {
    writeFiles(dir, {
      "go.mod": "module example.com/app\n\ngo 1.22\n",
    });
    expect(detectVerifyCommands(dir)).toEqual({
      test: "go test ./...",
      build: "go build ./...",
      format: "gofmt -l .",
    });
  });

  it("detects Rust projects via Cargo.toml", () => {
    writeFiles(dir, {
      "Cargo.toml": "[package]\nname = \"app\"\n",
    });
    expect(detectVerifyCommands(dir)).toEqual({
      test: "cargo test",
      build: "cargo build",
      lint: "cargo clippy -- -D warnings",
    });
  });

  it("detects Python projects via pyproject.toml only when pytest appears", () => {
    writeFiles(dir, {
      "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-ra\"\n",
    });
    expect(detectVerifyCommands(dir)).toEqual({ test: "pytest" });
  });

  it("does not set test for pyproject.toml without pytest mentioned", () => {
    writeFiles(dir, {
      "pyproject.toml": "[project]\nname = \"app\"\n",
    });
    expect(detectVerifyCommands(dir)).toEqual({});
  });

  it("returns {} for a nonexistent directory", () => {
    expect(detectVerifyCommands(join(dir, "does-not-exist"))).toEqual({});
  });
});
