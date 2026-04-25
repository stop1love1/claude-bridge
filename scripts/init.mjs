#!/usr/bin/env node
/**
 * Workspace init scan.
 *
 * Walks the parent directory of the bridge, fingerprints each sibling
 * folder + lists loose files, and writes the result to
 * `sessions/init.md`. Plain ES module JavaScript so it runs identically
 * under `bun run init`, `npm run init`, and `pnpm run init` — no bun-
 * only / TypeScript-loader requirements.
 *
 * Output is gitignored (entire `sessions/*` except `.gitkeep`) — the
 * snapshot is local context for the running bridge, not project config.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const BRIDGE_ROOT = resolve(process.cwd());
const BRIDGE_FOLDER = basename(BRIDGE_ROOT);
const PARENT = dirname(BRIDGE_ROOT);
const SESSIONS_DIR = join(BRIDGE_ROOT, "sessions");
const OUT_PATH = join(SESSIONS_DIR, "init.md");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".vscode", ".idea", "dist", "build",
  ".next", "out", ".turbo", ".cache", ".pnpm-store", ".bridge-state",
  ".uploads", ".playwright-mcp", "coverage",
]);

const REPO_MARKERS = [
  "package.json", "pyproject.toml", "requirements.txt",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
  "tsconfig.json", "Gemfile", "composer.json", ".git",
];

function safeReadJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return null; }
}

function safeReadText(p, capBytes = 4096) {
  try { return readFileSync(p).subarray(0, capBytes).toString("utf8"); }
  catch { return null; }
}

function isCodeRepo(p) {
  return REPO_MARKERS.some((m) => existsSync(join(p, m)));
}

function deriveStack(repoPath) {
  const stack = [];
  const pkg = safeReadJson(join(repoPath, "package.json"));
  const deps = pkg
    ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
    : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(deps, k);

  if (has("next")) stack.push("next");
  else if (has("react") || has("react-dom")) stack.push("react");
  if (has("vue")) stack.push("vue");
  if (has("svelte")) stack.push("svelte");
  if (has("@nestjs/core")) stack.push("nestjs");
  if (has("express") && !has("next")) stack.push("express");
  if (has("fastify")) stack.push("fastify");
  if (has("tailwindcss")) stack.push("tailwindcss");
  if (has("prisma") || has("@prisma/client") ||
      existsSync(join(repoPath, "prisma", "schema.prisma"))) {
    if (!stack.includes("prisma")) stack.push("prisma");
  }
  if (has("typeorm")) stack.push("typeorm");

  if (existsSync(join(repoPath, "go.mod"))) stack.push("go");
  if (existsSync(join(repoPath, "pyproject.toml")) ||
      existsSync(join(repoPath, "requirements.txt"))) stack.push("python");
  if (existsSync(join(repoPath, "Cargo.toml"))) stack.push("rust");
  if (existsSync(join(repoPath, "Gemfile"))) stack.push("ruby");
  if (existsSync(join(repoPath, "pom.xml")) ||
      existsSync(join(repoPath, "build.gradle"))) stack.push("java");

  if (has("typescript") || existsSync(join(repoPath, "tsconfig.json"))) {
    stack.push("typescript");
  }
  return stack;
}

function deriveSummary(repoPath, name) {
  const pkg = safeReadJson(join(repoPath, "package.json"));
  for (const candidate of ["CLAUDE.md", "README.md", "readme.md"]) {
    const text = safeReadText(join(repoPath, candidate));
    if (!text) continue;
    const intro = extractMarkdownIntro(text);
    if (intro) return intro;
  }
  if (pkg?.description) return pkg.description;
  return `${name} (no README / package.json description)`;
}

function extractMarkdownIntro(md) {
  const lines = md.split(/\r?\n/);
  let heading = "";
  let paragraph = "";
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!heading && /^#{1,6}\s+/.test(line)) {
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    if (heading && line && !line.startsWith("#") &&
        !line.startsWith(">") && !line.startsWith("|")) {
      paragraph = line;
      break;
    }
  }
  if (heading && paragraph) return `${heading} — ${paragraph}`;
  return heading || paragraph || "";
}

function detectGitBranch(repoPath) {
  const head = safeReadText(join(repoPath, ".git", "HEAD"), 256);
  if (!head) return null;
  const m = head.match(/ref:\s+refs\/heads\/(\S+)/);
  if (m) return m[1];
  return head.trim().slice(0, 12);
}

function listTopLevelEntries(repoPath, cap = 12) {
  try {
    const entries = readdirSync(repoPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    if (entries.length <= cap) return entries;
    return [...entries.slice(0, cap), `… (+${entries.length - cap} more)`];
  } catch {
    return [];
  }
}

function scanSibling(name) {
  const repoPath = join(PARENT, name);
  const isRepo = isCodeRepo(repoPath);
  return {
    name,
    path: repoPath,
    isRepo,
    stack: isRepo ? deriveStack(repoPath) : [],
    summary: isRepo ? deriveSummary(repoPath, name) : "(not a code repo)",
    branch: isRepo ? detectGitBranch(repoPath) : null,
    topEntries: listTopLevelEntries(repoPath),
  };
}

function discoverWorkspace() {
  let entries;
  try {
    entries = readdirSync(PARENT, { withFileTypes: true });
  } catch (e) {
    console.error(`init: cannot read parent dir ${PARENT}: ${e.message}`);
    return { repos: [], folders: [], files: [] };
  }

  const repos = [];
  const folders = [];
  const files = [];

  for (const e of entries) {
    if (e.name === BRIDGE_FOLDER) continue;
    if (e.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isDirectory()) {
      const scanned = scanSibling(e.name);
      if (scanned.isRepo) repos.push(scanned);
      else folders.push(scanned);
    } else if (e.isFile()) {
      try {
        const st = statSync(join(PARENT, e.name));
        files.push({ name: e.name, bytes: st.size });
      } catch {
        files.push({ name: e.name, bytes: null });
      }
    }
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { repos, folders, files };
}

function formatBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function buildMarkdown({ repos, folders, files }) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    "# Workspace snapshot",
    "",
    `> Auto-generated by \`init\` on ${stamp}.`,
    `> Bridge folder: \`${BRIDGE_FOLDER}\` · Parent: \`${PARENT}\``,
    `> This file lives under \`sessions/\` (gitignored). Re-run \`bun run init\` (or \`npm\` / \`pnpm\`) to refresh.`,
    "",
    "## Sibling repos",
    "",
  ];

  if (repos.length === 0) {
    lines.push("_(no sibling code repos detected — clone or symlink your app folders next to the bridge, then re-run init.)_");
  } else {
    for (const r of repos) {
      lines.push(`### \`${r.name}\``);
      lines.push("");
      lines.push(`- **Summary:** ${r.summary}`);
      lines.push(`- **Stack:** ${r.stack.length ? r.stack.join(", ") : "(unknown)"}`);
      if (r.branch) lines.push(`- **Branch:** \`${r.branch}\``);
      lines.push(`- **Path:** \`../${r.name}\``);
      if (r.topEntries.length) {
        lines.push(`- **Top-level:** ${r.topEntries.map((e) => `\`${e}\``).join(", ")}`);
      }
      lines.push("");
    }
  }

  if (folders.length > 0) {
    lines.push("## Other folders (not detected as code repos)");
    lines.push("");
    for (const f of folders) {
      lines.push(`- \`${f.name}/\` — top-level: ${f.topEntries.slice(0, 6).map((e) => `\`${e}\``).join(", ") || "(empty)"}`);
    }
    lines.push("");
  }

  if (files.length > 0) {
    lines.push("## Loose files in parent dir");
    lines.push("");
    for (const f of files) {
      lines.push(`- \`${f.name}\` (${formatBytes(f.bytes)})`);
    }
    lines.push("");
  }

  lines.push("## Suggested BRIDGE.md Repos table");
  lines.push("");
  if (repos.length === 0) {
    lines.push("_(no candidates — populate manually.)_");
  } else {
    const w = Math.max("Folder name".length, ...repos.map((r) => r.name.length + 2));
    const pad = (s) => s + " ".repeat(w - s.length);
    lines.push(`| ${pad("Folder name")} |`);
    lines.push(`| ${"-".repeat(w)} |`);
    for (const r of repos) {
      lines.push(`| ${pad("`" + r.name + "`")} |`);
    }
    lines.push("");
    lines.push("Copy the rows above into the **Repos** section of `BRIDGE.md` to make them addressable by the coordinator.");
  }
  lines.push("");

  return lines.join("\n");
}

function main() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
  const ws = discoverWorkspace();
  const md = buildMarkdown(ws);
  writeFileSync(OUT_PATH, md, "utf8");

  console.log(`init: scanned ${PARENT}`);
  console.log(`  repos:   ${ws.repos.length}`);
  console.log(`  folders: ${ws.folders.length}`);
  console.log(`  files:   ${ws.files.length}`);
  for (const r of ws.repos) {
    console.log(`  - ${r.name} [${r.stack.join(", ") || "no stack"}]`);
  }
  console.log(`init: wrote ${OUT_PATH}`);
}

main();
