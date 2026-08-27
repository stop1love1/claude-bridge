
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BRIDGE_ROOT } from "./paths";
import type { App } from "./apps/types";
import { APP_NAME_RE, loadApps } from "./apps/manifest";
import { addApp } from "./apps/crud";

const STRONG_MARKERS: ReadonlyMap<string, number> = new Map([
  [".git", 10],
]);

const PROJECT_MARKERS: ReadonlyMap<string, number> = new Map([
  ["package.json", 6],
  ["pyproject.toml", 6],
  ["go.mod", 6],
  ["Cargo.toml", 6],
  ["pom.xml", 6],
  ["build.gradle", 6],
  ["build.gradle.kts", 6],
  ["Gemfile", 6],
  ["composer.json", 6],
  ["mix.exs", 6],
  ["Pipfile", 6],
  ["setup.py", 5],
  ["deno.json", 5],
  ["deno.jsonc", 5],
  ["flake.nix", 4],
  ["tsconfig.json", 4],
  ["requirements.txt", 4],
  ["setup.cfg", 4],
  ["Rakefile", 4],
  ["Dockerfile", 3],
  ["shell.nix", 3],
  ["Makefile", 2],
]);

const LOCKFILE_MARKERS: ReadonlyMap<string, number> = new Map([
  ["package-lock.json", 3],
  ["yarn.lock", 3],
  ["pnpm-lock.yaml", 3],
  ["bun.lockb", 3],
  ["bun.lock", 3],
  ["Cargo.lock", 3],
  ["Pipfile.lock", 3],
  ["poetry.lock", 3],
  ["composer.lock", 3],
  ["Gemfile.lock", 3],
  ["go.sum", 3],
]);

const MONOREPO_MARKERS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "turbo.json",
  "nx.json",
  "rush.json",
] as const;

const MONOREPO_CHILD_DIRS = ["packages", "apps", "services", "libs"] as const;

const SCORE_THRESHOLD = 5;

const MAX_DIRS_PER_ROOT = 200;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".vscode", ".idea", "dist", "build",
  ".next", "out", ".turbo", ".cache", ".pnpm-store", ".bridge-state",
  ".uploads", ".playwright-mcp", "coverage", ".venv", "venv", "__pycache__",
  "target", "bin", "obj", ".gradle", ".mvn",
]);

interface RepoScore {
  score: number;
  signals: string[];
  isMonorepoRoot: boolean;
}

function scoreRepo(p: string): RepoScore {
  let score = 0;
  const signals: string[] = [];
  let isMonorepoRoot = false;
  for (const [marker, weight] of STRONG_MARKERS) {
    if (existsSync(join(p, marker))) { score += weight; signals.push(marker); }
  }
  for (const [marker, weight] of PROJECT_MARKERS) {
    if (existsSync(join(p, marker))) { score += weight; signals.push(marker); }
  }
  for (const [marker, weight] of LOCKFILE_MARKERS) {
    if (existsSync(join(p, marker))) { score += weight; signals.push(marker); }
  }
  for (const marker of MONOREPO_MARKERS) {
    if (existsSync(join(p, marker))) {
      isMonorepoRoot = true;
      score += 2;
      signals.push(marker);
    }
  }
  return { score, signals, isMonorepoRoot };
}

function safeReadJson(p: string): { description?: string } | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as { description?: string }; }
  catch { return null; }
}

function deriveDescription(repoPath: string): string {
  const pkg = safeReadJson(join(repoPath, "package.json"));
  if (pkg?.description) return pkg.description;
  for (const candidate of ["CLAUDE.md", "README.md", "readme.md"]) {
    try {
      const text = readFileSync(join(repoPath, candidate)).subarray(0, 1024).toString("utf8");
      const m = text.match(/^#\s+(.+)$/m);
      if (m) return m[1].trim().slice(0, 200);
    } catch { }
  }
  return "";
}

function formatRawPath(absPath: string): string {
  const rel = relative(BRIDGE_ROOT, absPath).replace(/\\/g, "/");
  if (!rel || rel === ".") return absPath;
  const parentLadder = rel.match(/^(\.\.\/)+/)?.[0] ?? "";
  if (parentLadder.length > 3) return absPath;
  return rel;
}

function suggestAppName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!base || !/^[A-Za-z0-9]/.test(base)) base = `app-${base}`.replace(/^-+|-+$/g, "");
  if (!APP_NAME_RE.test(base)) base = "app";
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}-${n++}`;
  }
  return name;
}

export interface DetectCandidate {
  name: string;
  rawPath: string;
  absolutePath: string;
  description: string;
  signals: string[];
  score: number;
  alreadyRegistered: boolean;
  isMonorepoChild: boolean;
}

export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | { type: "skipped"; path: string; reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs" }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };

export interface DetectOptions {
  roots?: string[];
  depth?: number;
  onEvent?: (ev: DetectEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function detectAppCandidates(
  opts: DetectOptions = {},
): Promise<DetectCandidate[]> {
  const depth = Math.min(3, Math.max(1, opts.depth ?? 1));
  const requestedRoots = (opts.roots ?? [])
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const rootsAbs = (requestedRoots.length > 0 ? requestedRoots : [dirname(BRIDGE_ROOT)])
    .map((r) => (isAbsolute(r) ? resolve(r) : resolve(BRIDGE_ROOT, r)));

  const existing = loadApps();
  const knownNames = new Set(existing.map((a) => a.name));
  const knownPaths = new Set(existing.map((a) => a.path));

  const emit = async (ev: DetectEvent) => {
    try { await opts.onEvent?.(ev); } catch { }
  };

  await emit({ type: "started", roots: rootsAbs, depth });

  const candidates: DetectCandidate[] = [];
  const visited = new Set<string>();
  const takenNames = new Set(knownNames);
  let totalScanned = 0;
  let totalAlreadyRegistered = 0;

  for (const root of rootsAbs) {
    if (opts.signal?.aborted) break;
    await emit({ type: "scanning", root });

    const queue: { path: string; depthLeft: number; isMonorepoChild: boolean }[] = [
      { path: root, depthLeft: depth, isMonorepoChild: false },
    ];
    let dirsForRoot = 0;

    while (queue.length > 0) {
      if (opts.signal?.aborted) break;
      const { path: dir, depthLeft, isMonorepoChild } = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      if (++dirsForRoot > MAX_DIRS_PER_ROOT) {
        await emit({ type: "skipped", path: dir, reason: "max-dirs" });
        break;
      }

      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        await emit({ type: "skipped", path: dir, reason: "permission" });
        console.warn("detect: cannot read", dir, (err as Error).message);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const childPath = join(dir, entry.name);
        if (childPath === BRIDGE_ROOT) continue;
        if (visited.has(childPath)) continue;

        totalScanned += 1;
        if (totalScanned % 8 === 0) await new Promise((r) => setTimeout(r, 0));

        const repoScore = scoreRepo(childPath);
        const qualifies = repoScore.score >= SCORE_THRESHOLD;

        if (qualifies) {
          if (knownPaths.has(childPath)) {
            totalAlreadyRegistered += 1;
            await emit({
              type: "candidate",
              candidate: {
                name: existing.find((a) => a.path === childPath)?.name ?? entry.name,
                rawPath: formatRawPath(childPath),
                absolutePath: childPath,
                description: existing.find((a) => a.path === childPath)?.description ?? "",
                signals: repoScore.signals,
                score: repoScore.score,
                alreadyRegistered: true,
                isMonorepoChild,
              },
            });
            continue;
          }
          const suggestedName = suggestAppName(entry.name, takenNames);
          takenNames.add(suggestedName);
          const candidate: DetectCandidate = {
            name: suggestedName,
            rawPath: formatRawPath(childPath),
            absolutePath: childPath,
            description: deriveDescription(childPath),
            signals: repoScore.signals,
            score: repoScore.score,
            alreadyRegistered: false,
            isMonorepoChild,
          };
          candidates.push(candidate);
          await emit({ type: "candidate", candidate });

          if (repoScore.isMonorepoRoot) {
            for (const wsDir of MONOREPO_CHILD_DIRS) {
              const wsPath = join(childPath, wsDir);
              if (existsSync(wsPath)) {
                queue.push({ path: wsPath, depthLeft: 1, isMonorepoChild: true });
              }
            }
          }
          continue;
        }

        if (depthLeft > 1) {
          queue.push({ path: childPath, depthLeft: depthLeft - 1, isMonorepoChild });
        } else {
          await emit({ type: "skipped", path: childPath, reason: "not-a-repo" });
        }
      }
    }
  }

  await emit({
    type: "done",
    candidates: candidates.length,
    alreadyRegistered: totalAlreadyRegistered,
    scanned: totalScanned,
  });
  return candidates;
}

export interface AutoDetectResult {
  added: App[];
  skipped: { name: string; reason: "already-registered" | "not-a-repo" }[];
}

export async function autoDetectApps(): Promise<AutoDetectResult> {
  const candidates = await detectAppCandidates();
  const added: App[] = [];
  const skipped: AutoDetectResult["skipped"] = [];

  for (const c of candidates) {
    if (c.alreadyRegistered) {
      skipped.push({ name: c.name, reason: "already-registered" });
      continue;
    }
    const result = addApp({ name: c.name, path: c.rawPath, description: c.description });
    if (result.ok) added.push(result.app);
    else skipped.push({ name: c.name, reason: "not-a-repo" });
  }
  return { added, skipped };
}
