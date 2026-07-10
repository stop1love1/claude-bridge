/**
 * Auto-detect verify commands (test/lint/build/typecheck/format) for a
 * freshly-registered app so the operator doesn't have to hand-fill the
 * `AppVerify` config before the first run. Pure, synchronous, no LLM —
 * a heuristic over well-known manifest files. Every fs read + JSON
 * parse is wrapped in try/catch: a corrupt or unreadable manifest is
 * skipped, never thrown.
 *
 * Called from `addApp` (new registration) and the scan-rescan seam
 * (backfill when an app's `verify` is still empty).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppVerify } from "./apps";

/** npm's default placeholder for a freshly-scaffolded project. */
const NPM_TEST_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function readTextSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  const raw = readTextSafe(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function detectPackageManager(appPath: string): PackageManager {
  if (safeExists(join(appPath, "bun.lock")) || safeExists(join(appPath, "bun.lockb"))) {
    return "bun";
  }
  if (safeExists(join(appPath, "pnpm-lock.yaml"))) return "pnpm";
  if (safeExists(join(appPath, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Alias script names checked in priority order, first match wins. */
const TYPECHECK_ALIASES = ["typecheck", "tsc", "type-check", "check-types"];
const FORMAT_ALIASES = ["format", "fmt"];

function detectFromPackageJson(appPath: string): AppVerify {
  const result: AppVerify = {};
  const pkg = readJsonSafe(join(appPath, "package.json"));
  if (!pkg) return result;
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return result;
  const scriptsObj = scripts as Record<string, unknown>;

  const get = (key: string): string | undefined => {
    const v = scriptsObj[key];
    return typeof v === "string" && v.trim().length > 0 ? v : undefined;
  };

  const pm = detectPackageManager(appPath);

  const testScript = get("test");
  if (testScript !== undefined && testScript.trim() !== NPM_TEST_PLACEHOLDER) {
    result.test = `${pm} run test`;
  }
  if (get("lint") !== undefined) result.lint = `${pm} run lint`;
  if (get("build") !== undefined) result.build = `${pm} run build`;

  const typecheckKey = TYPECHECK_ALIASES.find((k) => get(k) !== undefined);
  if (typecheckKey) result.typecheck = `${pm} run ${typecheckKey}`;

  const formatKey = FORMAT_ALIASES.find((k) => get(k) !== undefined);
  if (formatKey) result.format = `${pm} run ${formatKey}`;

  return result;
}

function detectFromLanguageMarkers(appPath: string, result: AppVerify): void {
  if (safeExists(join(appPath, "go.mod"))) {
    result.test ??= "go test ./...";
    result.build ??= "go build ./...";
    result.format ??= "gofmt -l .";
    return;
  }
  if (safeExists(join(appPath, "Cargo.toml"))) {
    result.test ??= "cargo test";
    result.build ??= "cargo build";
    result.lint ??= "cargo clippy -- -D warnings";
    return;
  }
  const pyproject = readTextSafe(join(appPath, "pyproject.toml"));
  if (pyproject !== null && pyproject.includes("pytest")) {
    result.test ??= "pytest";
  }
}

/**
 * Heuristically detect verify commands for an app directory. Returns
 * `{}` when nothing recognizable is found (empty dir, no manifests,
 * unreadable files) — callers should treat that the same as "operator
 * hasn't configured verify yet" (see `hasAnyVerifyCommand` in
 * `verifyChain.ts`).
 */
export function detectVerifyCommands(appPath: string): AppVerify {
  const result = detectFromPackageJson(appPath);
  detectFromLanguageMarkers(appPath, result);
  return result;
}
