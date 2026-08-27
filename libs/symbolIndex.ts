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
  file: string;
  signature: string;
}

export interface SymbolIndex {
  appName: string;
  refreshedAt: string;
  scannedDirs: string[];
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

const EXPORT_RE =
  /^export\s+(?:async\s+|abstract\s+)?(function|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;

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
      kind = "component";
    }

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
    if (!rel || isAbsolute(rel)) continue;
    const root = join(appPath, rel);
    const within = relative(appPath, root);
    if (within.startsWith("..") || isAbsolute(within)) continue;
    if (!existsSync(root)) continue;
    let isDir = false;
    try { isDir = statSync(root).isDirectory(); } catch { }
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
