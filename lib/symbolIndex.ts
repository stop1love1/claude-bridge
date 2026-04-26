/**
 * P3a — symbol index scanner.
 *
 * Walks an app's "shared helper" directories (`lib/`, `utils/`,
 * `hooks/`, `components/ui/` by default — overridable per app via
 * `bridge.json.apps[].symbolDirs`) and extracts top-level exports as
 * a flat `SymbolEntry[]`. The result is cached on disk by
 * `symbolStore.ts` and injected into every child prompt as a list of
 * "available helpers" — the agent then knows what already exists in
 * the codebase before writing new code.
 *
 * This is the single biggest lever against "agent re-implements `cn`
 * because it didn't know the project already has it" — the most
 * common cause of style drift in LLM-generated code.
 *
 * Pure heuristic, regex-based: no TypeScript AST, no `ts-morph`. The
 * regex catches the four export shapes we care about
 * (`export const`, `export function`, `export class`, `export
 * interface/type`) and ignores the long tail (re-exports, decorators,
 * default exports — those add noise without helping the agent reuse
 * code).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

export type SymbolKind =
  | "function"
  | "const"
  | "class"
  | "interface"
  | "type"
  | "component";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  /** Path relative to the app root, posix-style separators. */
  file: string;
  /**
   * One-line signature snippet — the rest of the line after the name,
   * trimmed and capped. Empty for `interface`/`type` blocks (the body
   * is on subsequent lines). Useful for the agent to know arity /
   * parameter shape without opening the file.
   */
  signature: string;
}

export interface SymbolIndex {
  appName: string;
  refreshedAt: string;
  /** Dirs the scanner actually walked (after filtering missing ones). */
  scannedDirs: string[];
  /** Total source files visited (cap-bounded). */
  fileCount: number;
  symbols: SymbolEntry[];
}

const DEFAULT_DIRS = ["lib", "utils", "hooks", "components/ui"];
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".bridge-state", ".uploads", ".cache", ".turbo", "__tests__", "__mocks__",
]);
const SKIP_FILE_SUFFIXES = [
  ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
  ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
  ".d.ts",
];

const FILE_WALK_CAP = 1500;
const SYMBOL_CAP = 400;
const READ_CAP_BYTES = 64 * 1024;
const SIGNATURE_CAP = 120;
const WALK_DEPTH_CAP = 6;

/**
 * One regex captures all four shapes. Positional groups (1 = kind,
 * 2 = name) — named groups would require ES2018 and the project
 * targets ES2017. Kind ∈ {function, const, let, var, class, interface,
 * type}; name is the identifier. `async`/`abstract` are tolerated but
 * don't change the bucket — `default` exports are dropped further down
 * because they don't carry a useful name.
 */
const EXPORT_RE =
  /^export\s+(?:async\s+|abstract\s+)?(function|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Component detector: PascalCase name AND file is .tsx/.jsx. Lets us
 * promote a `const Button = (...)` to `kind: "component"` so the
 * prompt rendering can group components separately from utility
 * helpers (more useful to the agent).
 */
function looksLikeComponent(name: string, file: string): boolean {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return false;
  return file.endsWith(".tsx") || file.endsWith(".jsx");
}

function fileShouldSkip(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s));
}

function dirShouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

function isSourceFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SOURCE_EXTS.has(name.slice(dot).toLowerCase());
}

interface WalkResult {
  files: string[];
  capped: boolean;
}

function walkSourceFiles(root: string): WalkResult {
  const out: string[] = [];
  let capped = false;

  const visit = (dir: string, depth: number): void => {
    if (capped) return;
    if (depth > WALK_DEPTH_CAP) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (capped) return;
      if (e.isDirectory()) {
        if (dirShouldSkip(e.name)) continue;
        visit(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        if (fileShouldSkip(e.name)) continue;
        if (!isSourceFile(e.name)) continue;
        out.push(join(dir, e.name));
        if (out.length >= FILE_WALK_CAP) {
          capped = true;
          return;
        }
      }
    }
  };

  visit(root, 0);
  return { files: out, capped };
}

/**
 * Pull every top-level `export <kind> <name>` declaration out of a
 * source file. We capture just the line the name sits on; the
 * signature is the trailing slice after the name (trimmed + capped).
 * `default` exports are dropped because the name we'd capture is the
 * keyword `default`, not the export's identity.
 */
function extractExports(text: string, fileRel: string): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(text)) !== null) {
    const rawKind = m[1] ?? "";
    const name = m[2] ?? "";
    if (!name) continue;
    if (name === "default") continue;

    const kindMap: Record<string, SymbolKind> = {
      function: "function",
      class: "class",
      interface: "interface",
      type: "type",
      const: "const",
      let: "const",
      var: "const",
    };
    let kind: SymbolKind = kindMap[rawKind] ?? "const";
    if (kind === "const" && looksLikeComponent(name, fileRel)) {
      kind = "component";
    } else if (kind === "function" && looksLikeComponent(name, fileRel)) {
      // function components are a thing too
      kind = "component";
    }

    // Capture the rest of the line after `name` for the signature.
    // We start scanning from the index AFTER the matched header so the
    // signature reflects the function/const body's first line.
    const headerEnd = m.index + m[0].length;
    const lineEnd = text.indexOf("\n", headerEnd);
    const tail = (lineEnd === -1 ? text.slice(headerEnd) : text.slice(headerEnd, lineEnd))
      .trim()
      .replace(/\s+/g, " ");
    const signature = tail.length > SIGNATURE_CAP
      ? tail.slice(0, SIGNATURE_CAP) + "…"
      : tail;

    out.push({ name, kind, file: fileRel, signature });
  }
  return out;
}

function safeReadCapped(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, READ_CAP_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Scan an app and return its `SymbolIndex`. Always returns; falls
 * back to an empty `symbols` list when no source files exist or none
 * of the configured dirs are present. Never throws.
 *
 * @param symbolDirs  override the default `[lib, utils, hooks, components/ui]`
 *                    set per `bridge.json.apps[].symbolDirs`. Pass `[]` to
 *                    use the defaults; pass a non-empty list to use them.
 */
export function scanSymbols(
  appPath: string,
  symbolDirs: string[] = [],
): SymbolIndex {
  const appName = basename(appPath);
  const refreshedAt = new Date().toISOString();
  const dirs = symbolDirs.length > 0 ? symbolDirs : DEFAULT_DIRS;
  const scannedDirs: string[] = [];
  const allSymbols: SymbolEntry[] = [];
  let totalFiles = 0;

  for (const rel of dirs) {
    // Defense-in-depth: bridge.json is operator-trusted, but a stray
    // `../../etc` in `symbolDirs` would otherwise let the scanner
    // walk outside the app. Mirrors `pinnedFiles.resolveSafely`:
    // reject absolute paths and any relative path that resolves
    // outside `appPath`.
    if (!rel || isAbsolute(rel)) continue;
    const root = join(appPath, rel);
    const within = relative(appPath, root);
    if (within.startsWith("..") || isAbsolute(within)) continue;
    if (!existsSync(root)) continue;
    let isDir = false;
    try { isDir = statSync(root).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;

    scannedDirs.push(rel);
    const { files } = walkSourceFiles(root);
    totalFiles += files.length;
    for (const abs of files) {
      const text = safeReadCapped(abs);
      if (!text) continue;
      const fileRel = relative(appPath, abs).replace(/\\/g, "/");
      const fileSyms = extractExports(text, fileRel);
      for (const s of fileSyms) {
        if (allSymbols.length >= SYMBOL_CAP) break;
        allSymbols.push(s);
      }
      if (allSymbols.length >= SYMBOL_CAP) break;
    }
    if (allSymbols.length >= SYMBOL_CAP) break;
  }

  return {
    appName,
    refreshedAt,
    scannedDirs,
    fileCount: totalFiles,
    symbols: allSymbols,
  };
}

// Internal helpers exposed for testing only.
export const __test = {
  EXPORT_RE,
  extractExports,
  walkSourceFiles,
  looksLikeComponent,
  FILE_WALK_CAP,
  SYMBOL_CAP,
  SIGNATURE_CAP,
  DEFAULT_DIRS,
};
