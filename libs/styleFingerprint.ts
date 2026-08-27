import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export type IndentKind = "spaces" | "tabs" | "unknown";
export type QuoteStyle = "single" | "double" | "mixed" | "unknown";
export type SemicolonStyle = "always" | "never" | "mixed" | "unknown";
export type TrailingCommaStyle = "all" | "none" | "mixed" | "unknown";
export type ExportPreference = "named" | "default" | "mixed" | "unknown";
export type FileCaseStyle =
  | "PascalCase"
  | "kebab-case"
  | "camelCase"
  | "mixed"
  | "unknown";

export interface StyleFingerprint {
  appName: string;
  refreshedAt: string;
  sampledFiles: number;
  indent: { kind: IndentKind; width: number };
  quotes: QuoteStyle;
  semicolons: SemicolonStyle;
  trailingComma: TrailingCommaStyle;
  exports: ExportPreference;
  fileNaming: {
    tsx: FileCaseStyle;
    ts: FileCaseStyle;
  };
}

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx"] as const;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".bridge-state", ".uploads", ".cache", ".turbo", "__tests__", "__mocks__",
  "public",
]);
const SKIP_FILE_SUFFIXES = [
  ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
  ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
  ".d.ts",
];

const FILE_SAMPLE_CAP = 50;
const READ_CAP_BYTES = 32 * 1024;
const WALK_DEPTH_CAP = 5;

interface Tally {
  spaces2: number;
  spaces4: number;
  tabs: number;
  singleQuotes: number;
  doubleQuotes: number;
  endsSemi: number;
  endsBare: number;
  trailingComma: number;
  noTrailingComma: number;
  defaultExports: number;
  namedExports: number;
  tsxPascal: number;
  tsxKebab: number;
  tsxCamel: number;
  tsxOther: number;
  tsPascal: number;
  tsKebab: number;
  tsCamel: number;
  tsOther: number;
}

function newTally(): Tally {
  return {
    spaces2: 0, spaces4: 0, tabs: 0,
    singleQuotes: 0, doubleQuotes: 0,
    endsSemi: 0, endsBare: 0,
    trailingComma: 0, noTrailingComma: 0,
    defaultExports: 0, namedExports: 0,
    tsxPascal: 0, tsxKebab: 0, tsxCamel: 0, tsxOther: 0,
    tsPascal: 0, tsKebab: 0, tsCamel: 0, tsOther: 0,
  };
}

function fileShouldSkip(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s));
}

function dirShouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

function isSourceFile(name: string): boolean {
  return SOURCE_EXTS.some((ext) => name.endsWith(ext));
}

function sampleFiles(appPath: string): string[] {
  const tsFiles: string[] = [];
  const jsFiles: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (tsFiles.length + jsFiles.length >= FILE_SAMPLE_CAP * 2) return;
    if (depth > WALK_DEPTH_CAP) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (dirShouldSkip(e.name)) continue;
        visit(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        if (fileShouldSkip(e.name)) continue;
        if (!isSourceFile(e.name)) continue;
        const full = join(dir, e.name);
        if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
          tsFiles.push(full);
        } else {
          jsFiles.push(full);
        }
      }
    }
  };

  visit(appPath, 0);

  if (tsFiles.length >= FILE_SAMPLE_CAP) return tsFiles.slice(0, FILE_SAMPLE_CAP);
  const need = FILE_SAMPLE_CAP - tsFiles.length;
  return [...tsFiles, ...jsFiles.slice(0, need)];
}

function safeReadCapped(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, READ_CAP_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

function tallyFile(text: string, fileName: string, t: Tally): void {
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;

  for (const raw of lines) {
    const line = raw;
    if (!line.trim()) continue;

    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("*")) continue;

    if (/^\s/.test(line)) {
      if (line.startsWith("\t")) {
        t.tabs += 1;
      } else if (line.startsWith("    ")) {
        t.spaces4 += 1;
      } else if (line.startsWith("  ")) {
        t.spaces2 += 1;
      }
    }

    const sq = (line.match(/'/g) ?? []).length;
    const dq = (line.match(/"/g) ?? []).length;
    if (sq > dq) t.singleQuotes += 1;
    else if (dq > sq) t.doubleQuotes += 1;

    const stripped = line.replace(/\/\/.*$/, "").trimEnd();
    if (stripped.length > 0) {
      const last = stripped[stripped.length - 1];
      if (last === ";") t.endsSemi += 1;
      else if (/[\w)\]]/.test(last)) {
        if (last !== "{" && last !== "," && last !== ":") {
          t.endsBare += 1;
        }
      }
    }

    if (/^\s/.test(line)) {
      const sLast = stripped[stripped.length - 1];
      if (sLast === ",") t.trailingComma += 1;
      else if (sLast === ")" || sLast === "]" || sLast === "}") t.noTrailingComma += 1;
    }

    if (/^export\s+default\b/.test(trimmed)) t.defaultExports += 1;
    else if (/^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\b/.test(trimmed)) {
      t.namedExports += 1;
    }
  }

  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return;
  const ext = fileName.slice(dot).toLowerCase();
  const stem = fileName.slice(0, dot);
  const casing = classifyFileName(stem);
  if (ext === ".tsx") {
    if (casing === "PascalCase") t.tsxPascal += 1;
    else if (casing === "kebab-case") t.tsxKebab += 1;
    else if (casing === "camelCase") t.tsxCamel += 1;
    else t.tsxOther += 1;
  } else if (ext === ".ts") {
    if (casing === "PascalCase") t.tsPascal += 1;
    else if (casing === "kebab-case") t.tsKebab += 1;
    else if (casing === "camelCase") t.tsCamel += 1;
    else t.tsOther += 1;
  }
}

export function classifyFileName(stem: string): FileCaseStyle {
  if (!stem) return "unknown";
  const norm = stem.replace(/\.(test|spec)$/i, "");
  if (/^[A-Z][A-Za-z0-9]*$/.test(norm) && /[a-z]/.test(norm)) return "PascalCase";
  if (/^[a-z]+(-[a-z0-9]+)+$/.test(norm)) return "kebab-case";
  if (/^[a-z][a-zA-Z0-9]*$/.test(norm)) return "camelCase";
  return "mixed";
}

interface MajorityCfg {
  threshold: number;
}

export function pickMajority<T extends string>(
  buckets: Array<{ label: T; count: number }>,
  cfg: MajorityCfg = { threshold: 0.7 },
  fallbackUnknown: T,
  fallbackMixed: T,
): T {
  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return fallbackUnknown;
  buckets.sort((a, b) => b.count - a.count);
  const top = buckets[0];
  if (top.count / total >= cfg.threshold) return top.label;
  return fallbackMixed;
}

export function scanStyle(appPath: string): StyleFingerprint {
  const appName = basename(appPath);
  const refreshedAt = new Date().toISOString();

  const files = sampleFiles(appPath);
  const t = newTally();

  for (const abs of files) {
    const text = safeReadCapped(abs);
    if (!text) continue;
    tallyFile(text, basename(abs), t);
  }

  const indentBuckets = [
    { label: "spaces2" as const, count: t.spaces2 },
    { label: "spaces4" as const, count: t.spaces4 },
    { label: "tabs" as const, count: t.tabs },
  ];
  const indentWinner = pickMajority(
    indentBuckets,
    { threshold: 0.6 },
    "unknown",
    "mixed",
  );
  let indent: { kind: IndentKind; width: number };
  if (indentWinner === "spaces2") indent = { kind: "spaces", width: 2 };
  else if (indentWinner === "spaces4") indent = { kind: "spaces", width: 4 };
  else if (indentWinner === "tabs") indent = { kind: "tabs", width: 1 };
  else if (indentWinner === "mixed") indent = { kind: "spaces", width: 2 };
  else indent = { kind: "unknown", width: 0 };

  const quotes = pickMajority(
    [
      { label: "single" as const, count: t.singleQuotes },
      { label: "double" as const, count: t.doubleQuotes },
    ],
    { threshold: 0.7 },
    "unknown",
    "mixed",
  );

  const semicolons = pickMajority(
    [
      { label: "always" as const, count: t.endsSemi },
      { label: "never" as const, count: t.endsBare },
    ],
    { threshold: 0.7 },
    "unknown",
    "mixed",
  );

  const trailingComma = pickMajority(
    [
      { label: "all" as const, count: t.trailingComma },
      { label: "none" as const, count: t.noTrailingComma },
    ],
    { threshold: 0.6 },
    "unknown",
    "mixed",
  );

  const exports = pickMajority(
    [
      { label: "named" as const, count: t.namedExports },
      { label: "default" as const, count: t.defaultExports },
    ],
    { threshold: 0.6 },
    "unknown",
    "mixed",
  );

  const tsx = pickMajority(
    [
      { label: "PascalCase" as const, count: t.tsxPascal },
      { label: "kebab-case" as const, count: t.tsxKebab },
      { label: "camelCase" as const, count: t.tsxCamel },
    ],
    { threshold: 0.6 },
    "unknown",
    "mixed",
  );
  const ts = pickMajority(
    [
      { label: "PascalCase" as const, count: t.tsPascal },
      { label: "kebab-case" as const, count: t.tsKebab },
      { label: "camelCase" as const, count: t.tsCamel },
    ],
    { threshold: 0.6 },
    "unknown",
    "mixed",
  );

  return {
    appName,
    refreshedAt,
    sampledFiles: files.length,
    indent,
    quotes,
    semicolons,
    trailingComma,
    exports,
    fileNaming: { tsx, ts },
  };
}

export const __test = {
  classifyFileName,
  pickMajority,
  sampleFiles,
  tallyFile,
  newTally,
  FILE_SAMPLE_CAP,
};
