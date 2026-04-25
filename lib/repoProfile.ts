/**
 * Phase G — repo profile scanner.
 *
 * Synchronously walks a sibling repo and derives a `RepoProfile`: stack
 * (next, nestjs, prisma, …), domain keywords, high-level features (auth,
 * payments, lms, …), and entrypoint glob patterns. Pure heuristic, no LLM
 * calls — every read is `try/catch` so a half-checked-out / network-broken
 * sibling never crashes the bridge.
 *
 * Two consumers:
 *  - `repoHeuristic.ts` — boosts the keyword scoring with profile signals.
 *  - `coordinator.ts`   — prepends a "## Repo profiles" block to every
 *                         coordinator prompt so the LLM knows the
 *                         contract surface of each candidate repo.
 *
 * TODO: an LLM-assisted upgrade can plug in later via a
 * `summarizeWithLLM(profile)` hook on top of this heuristic baseline.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

export type RouterStyle = "app" | "pages" | "src" | "unknown";
export type PrimaryLang = "ts" | "js" | "py" | "go" | "java" | "unknown";

export interface RepoProfileSignals {
  hasPackageJson: boolean;
  hasReadme: boolean;
  hasClaudeMd: boolean;
  hasNextConfig: boolean;
  hasPrismaSchema: boolean;
  hasTailwindConfig: boolean;
  hasNestCoreDep: boolean;
  hasReactDep: boolean;
  routerStyle: RouterStyle;
  primaryLang: PrimaryLang;
}

export interface RepoProfile {
  name: string;
  path: string;
  summary: string;
  stack: string[];
  keywords: string[];
  features: string[];
  entrypoints: string[];
  fileCounts: Record<string, number>;
  refreshedAt: string;
  signals: RepoProfileSignals;
}

const READ_CAP_BYTES = 4096;
const FILE_WALK_CAP = 5000;
const KEYWORD_CAP = 40;
const TOP_EXTENSIONS_CAP = 5;
const WALK_DEPTH_CAP = 4;

const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", ".git", "coverage", ".turbo",
  ".cache", ".vercel", ".bridge-state", ".uploads", "out", ".pnpm-store",
]);

const STOPWORDS = new Set([
  "the", "and", "of", "to", "a", "an", "in", "for", "with", "on", "this",
  "that", "is", "are", "be", "by", "as", "or", "at", "from", "it", "its",
  "src", "lib", "app", "public", "dist", "build", "node_modules", "test",
  "tests", "spec", "specs", "pages", "components", "page", "component",
  "config", "configs", "json", "ts", "tsx", "js", "jsx", "md", "mjs",
  "package", "lock", "readme", "license", "docs", "doc",
]);

/**
 * Top-level rules used to derive `features[]`. Order matters only for
 * de-dupe; matching is independent per rule.
 *
 * Each rule scans the union of: deps, top-level dir names, prisma model
 * names, and harvested keywords, looking for any of `match[]` as a
 * substring (lowercased). One hit → feature added once.
 */
const FEATURE_RULES: { feature: string; match: string[] }[] = [
  { feature: "auth",          match: ["auth", "login", "jwt", "oauth", "session"] },
  { feature: "payments",      match: ["payment", "billing", "stripe", "invoice", "subscription"] },
  { feature: "i18n",          match: ["i18n", "locale", "translation", "intl"] },
  { feature: "notifications", match: ["notification", "email", "sms", "mail", "push"] },
  { feature: "messaging",     match: ["chat", "message", "conversation", "thread"] },
  { feature: "lms",           match: ["lms", "course", "lesson", "student", "teacher", "classroom", "quiz", "exam"] },
  { feature: "orchestration", match: ["coordinator", "bridge", "orchestrat", "agent"] },
];

interface ParsedPackageJson {
  deps: Record<string, string>;
  name?: string;
  description?: string;
}

function safeReadText(path: string, capBytes = READ_CAP_BYTES): string | null {
  try {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    return buf.subarray(0, capBytes).toString("utf8");
  } catch {
    return null;
  }
}

function safeReadJson<T>(path: string): T | null {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function parsePackageJson(repoPath: string): ParsedPackageJson | null {
  const pkg = safeReadJson<{
    name?: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }>(join(repoPath, "package.json"));
  if (!pkg) return null;
  const deps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  return { deps, name: pkg.name, description: pkg.description };
}

function detectRouterStyle(repoPath: string): RouterStyle {
  const hasApp = existsSync(join(repoPath, "app"));
  const hasPages = existsSync(join(repoPath, "pages"));
  const hasSrcApp = existsSync(join(repoPath, "src", "app"));
  const hasSrcPages = existsSync(join(repoPath, "src", "pages"));
  if (hasApp || hasSrcApp) return "app";
  if (hasPages || hasSrcPages) return "pages";
  if (existsSync(join(repoPath, "src"))) return "src";
  return "unknown";
}

function detectPrimaryLang(
  repoPath: string,
  pkg: ParsedPackageJson | null,
): PrimaryLang {
  if (existsSync(join(repoPath, "pyproject.toml")) || existsSync(join(repoPath, "requirements.txt"))) {
    return "py";
  }
  if (existsSync(join(repoPath, "go.mod"))) return "go";
  if (existsSync(join(repoPath, "pom.xml")) || existsSync(join(repoPath, "build.gradle"))) {
    return "java";
  }
  if (pkg) {
    if (pkg.deps["typescript"] || existsSync(join(repoPath, "tsconfig.json"))) return "ts";
    return "js";
  }
  return "unknown";
}

function existsAny(repoPath: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(repoPath, n)));
}

/**
 * Walk the repo from a small set of meaningful roots, counting file
 * extensions. Bounded by `FILE_WALK_CAP` and `WALK_DEPTH_CAP` so a
 * pathological tree can't lock us up.
 */
function countExtensions(repoPath: string): { counts: Record<string, number>; topLevelDirs: string[] } {
  const counts: Record<string, number> = {};
  const topLevelDirs: string[] = [];
  let visited = 0;

  // Collect top-level dir names first (used for keyword harvest).
  try {
    for (const e of readdirSync(repoPath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      topLevelDirs.push(e.name);
    }
  } catch {
    /* unreadable repo root */
  }

  const walk = (dir: string, depth: number): boolean => {
    if (visited >= FILE_WALK_CAP) return false;
    if (depth > WALK_DEPTH_CAP) return true;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (visited >= FILE_WALK_CAP) return false;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!walk(full, depth + 1)) return false;
      } else if (e.isFile()) {
        visited += 1;
        const dot = e.name.lastIndexOf(".");
        if (dot > 0) {
          const ext = e.name.slice(dot).toLowerCase();
          counts[ext] = (counts[ext] ?? 0) + 1;
        }
      }
    }
    return true;
  };

  walk(repoPath, 0);
  return { counts, topLevelDirs };
}

function topNExtensions(counts: Record<string, number>, n: number): Record<string, number> {
  const out: Record<string, number> = {};
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .forEach(([ext, count]) => { out[ext] = count; });
  return out;
}

/**
 * Pull the first heading + first non-empty paragraph out of a markdown
 * blob (≤4 KB). Used for the human `summary` field.
 */
function extractMarkdownIntro(md: string): string {
  const lines = md.split(/\r?\n/);
  let heading = "";
  let paragraph = "";
  let inCodeFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!heading && /^#{1,6}\s+/.test(line)) {
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    if (heading && line && !line.startsWith("#") && !line.startsWith(">") && !line.startsWith("|")) {
      paragraph = line;
      break;
    }
  }
  if (heading && paragraph) return `${heading} — ${paragraph}`;
  return heading || paragraph || "";
}

/**
 * Read prisma/schema.prisma if present and pluck out `model Foo {…}` /
 * `enum Bar {…}` declarations as keyword candidates.
 */
function readPrismaModels(repoPath: string): string[] {
  const text = safeReadText(join(repoPath, "prisma", "schema.prisma"), 64 * 1024);
  if (!text) return [];
  const out = new Set<string>();
  const re = /^(?:model|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function deriveStack(
  pkg: ParsedPackageJson | null,
  repoPath: string,
  primaryLang: PrimaryLang,
): { stack: string[]; signals: Pick<RepoProfileSignals,
    "hasNextConfig" | "hasPrismaSchema" | "hasTailwindConfig"
    | "hasNestCoreDep" | "hasReactDep"> } {
  const stack = new Set<string>();
  const deps = pkg?.deps ?? {};

  const hasNext = !!deps["next"];
  const hasReact = !!deps["react"] || !!deps["react-dom"];
  const hasVue = !!deps["vue"];
  const hasSvelte = !!deps["svelte"];
  const hasNest = !!deps["@nestjs/core"];
  const hasExpress = !!deps["express"];
  const hasTailwind = !!deps["tailwindcss"];
  const hasPrismaDep = !!deps["prisma"] || !!deps["@prisma/client"];
  const hasTypeorm = !!deps["typeorm"];
  const hasAnthropic = !!deps["@anthropic-ai/sdk"];
  const hasPlaywright = !!deps["playwright"] || !!deps["@playwright/test"];

  if (hasNext) stack.add("next");
  // omit react when next is present (redundant)
  if (hasReact && !hasNext) stack.add("react");
  if (hasVue) stack.add("vue");
  if (hasSvelte) stack.add("svelte");
  if (hasNest) stack.add("nestjs");
  if (hasExpress && !hasNext) stack.add("express");
  if (hasTailwind) stack.add("tailwindcss");
  if (hasPrismaDep) stack.add("prisma");
  if (hasTypeorm) stack.add("typeorm");
  if (hasAnthropic) stack.add("anthropic-sdk");
  if (hasPlaywright) stack.add("playwright");

  // File-based confirmation / fallbacks.
  const hasNextConfig = existsAny(repoPath, [
    "next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs",
  ]);
  if (hasNextConfig) stack.add("next");

  const hasPrismaSchema = existsSync(join(repoPath, "prisma", "schema.prisma"));
  if (hasPrismaSchema) stack.add("prisma");

  const hasTailwindConfig = existsAny(repoPath, [
    "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.ts", "tailwind.config.cjs",
  ]);
  if (hasTailwindConfig) stack.add("tailwindcss");

  if (primaryLang === "py") stack.add("python");
  if (primaryLang === "go") stack.add("go");
  if (primaryLang === "java") stack.add("java");
  if (primaryLang === "ts") stack.add("typescript");

  return {
    stack: [...stack],
    signals: {
      hasNextConfig,
      hasPrismaSchema,
      hasTailwindConfig,
      hasNestCoreDep: hasNest,
      hasReactDep: hasReact,
    },
  };
}

function deriveEntrypoints(
  stack: string[],
  routerStyle: RouterStyle,
  primaryLang: PrimaryLang,
  repoPath: string,
): string[] {
  const out: string[] = [];
  const hasNext = stack.includes("next");
  const hasNest = stack.includes("nestjs");

  if (hasNext) {
    if (routerStyle === "app") {
      out.push("app/api/**/*.ts", "app/**/*.tsx");
    } else if (routerStyle === "pages") {
      out.push("pages/api/**/*.ts", "pages/**/*.tsx");
    } else {
      // unknown / src — best guess
      out.push("app/**/*.tsx", "pages/**/*.tsx");
    }
  }
  if (hasNest) {
    out.push(
      "src/**/*.controller.ts",
      "src/**/*.service.ts",
      "src/**/*.module.ts",
    );
  }
  if (!hasNext && !hasNest) {
    if (primaryLang === "ts" || primaryLang === "js") {
      if (existsSync(join(repoPath, "src"))) out.push("src/**/*.ts");
      if (existsSync(join(repoPath, "lib"))) out.push("lib/**/*.ts");
      if (out.length === 0) out.push("**/*.ts");
    } else if (primaryLang === "py") {
      out.push("**/*.py");
    } else if (primaryLang === "go") {
      out.push("**/*.go");
    } else if (primaryLang === "java") {
      out.push("src/main/java/**/*.java");
    }
  }

  return dedupe(out);
}

function deriveFeatures(haystack: string[]): string[] {
  const blob = haystack.join(" ").toLowerCase();
  const out: string[] = [];
  for (const rule of FEATURE_RULES) {
    if (rule.match.some((needle) => blob.includes(needle))) {
      out.push(rule.feature);
    }
  }
  return dedupe(out);
}

function synthesizeSummary(name: string, stack: string[]): string {
  if (stack.length === 0) return `${name} — repo (no README found, no recognised stack)`;
  const tag = stack.slice(0, 4).join(" + ");
  return `${name} — ${tag} (no README found)`;
}

/**
 * Scan `repoPath` and produce a `RepoProfile`. Always returns; falls
 * back to a synthesized summary + empty stack when there's no
 * package.json / README / etc. Never throws.
 */
export function scanRepo(repoPath: string): RepoProfile {
  const name = basename(repoPath);
  const pkg = parsePackageJson(repoPath);
  const primaryLang = detectPrimaryLang(repoPath, pkg);
  const routerStyle = detectRouterStyle(repoPath);
  const { stack, signals: stackSignals } = deriveStack(pkg, repoPath, primaryLang);

  const claudeMd = safeReadText(join(repoPath, "CLAUDE.md"));
  const readme = safeReadText(join(repoPath, "README.md"));
  const claudeIntro = claudeMd ? extractMarkdownIntro(claudeMd) : "";
  const readmeIntro = readme ? extractMarkdownIntro(readme) : "";
  const summary =
    claudeIntro ||
    readmeIntro ||
    pkg?.description ||
    synthesizeSummary(name, stack);

  const prismaModels = readPrismaModels(repoPath);
  const { counts, topLevelDirs } = countExtensions(repoPath);
  const fileCounts = topNExtensions(counts, TOP_EXTENSIONS_CAP);

  // Keyword harvest: summary + dep names (split on -/_) + prisma models +
  // top-level dir names + pkg name. Lowercase, strip stopwords, dedupe.
  const depTokens = Object.keys(pkg?.deps ?? {}).flatMap((d) =>
    d.replace(/^@/, "").split(/[/_-]+/g),
  );
  const harvest = [
    ...tokenize(summary),
    ...tokenize(depTokens.join(" ")),
    ...prismaModels,
    ...tokenize(topLevelDirs.join(" ")),
    ...(pkg?.name ? tokenize(pkg.name) : []),
  ];
  const keywords = dedupe(
    harvest.filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  ).slice(0, KEYWORD_CAP);

  const features = deriveFeatures([
    ...keywords,
    ...topLevelDirs,
    ...Object.keys(pkg?.deps ?? {}),
  ]);

  const entrypoints = deriveEntrypoints(stack, routerStyle, primaryLang, repoPath);

  const signals: RepoProfileSignals = {
    hasPackageJson: !!pkg,
    hasReadme: !!readme,
    hasClaudeMd: !!claudeMd,
    routerStyle,
    primaryLang,
    ...stackSignals,
  };

  return {
    name,
    path: repoPath,
    summary,
    stack,
    keywords,
    features,
    entrypoints,
    fileCounts,
    refreshedAt: new Date().toISOString(),
    signals,
  };
}

// Internal helpers exposed for testing only.
export const __test = {
  STOPWORDS,
  FEATURE_RULES,
  tokenize,
  extractMarkdownIntro,
  countExtensions,
  FILE_WALK_CAP,
  KEYWORD_CAP,
};

/**
 * Light placeholder so callers can wire an LLM-driven enrichment later.
 * Returns the profile as-is; replace impl when an SDK is available.
 */
export function summarizeWithLLM(profile: RepoProfile): RepoProfile {
  return profile;
}

/**
 * Helper for callers that want to skip the path/stat dance themselves.
 * `existsCheck = false` short-circuits without touching disk.
 */
export function scanRepoIfExists(
  repoPath: string,
  existsCheck = true,
): RepoProfile | null {
  try {
    if (existsCheck) {
      const st = statSync(repoPath);
      if (!st.isDirectory()) return null;
    }
    return scanRepo(repoPath);
  } catch {
    return null;
  }
}
