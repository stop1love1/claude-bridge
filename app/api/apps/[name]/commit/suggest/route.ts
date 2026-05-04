/**
 * Heuristic commit-message suggester for an app's live tree.
 * App-scoped sibling of the per-run suggester — same parsing /
 * heuristic logic, just runs against `app.path` directly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getApp, isValidAppName } from "@/libs/apps";
import { badRequest } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const TIMEOUT_MS = 5_000;

type Ctx = { params: Promise<{ name: string }> };

interface NameStatusLine {
  status: "A" | "D" | "M" | "R" | "T" | "C";
  path: string;
  oldPath?: string;
}

function parseNameStatus(out: string): NameStatusLine[] {
  const rows: NameStatusLine[] = [];
  for (const ln of out.split("\n")) {
    if (!ln.trim()) continue;
    const parts = ln.split("\t");
    const head = parts[0] ?? "";
    if (head.startsWith("R") && parts.length >= 3) {
      rows.push({ status: "R", oldPath: parts[1], path: parts[2] });
      continue;
    }
    const status = head[0];
    if (status === "A" || status === "D" || status === "M" || status === "T" || status === "C") {
      rows.push({ status: status as NameStatusLine["status"], path: parts[1] ?? "" });
    }
  }
  return rows;
}

const GENERIC_TOPS = new Set([
  "src", "app", "lib", "libs", "components", "pkg", "internal",
  "packages", "modules", "module",
]);

function deriveScope(paths: string[]): string {
  if (paths.length === 0) return "";
  const splits = paths.map((p) => p.split("/"));
  const minLen = Math.min(...splits.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const seg = splits[0][i];
    if (splits.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  while (common.length > 0 && GENERIC_TOPS.has(common[0])) common.shift();
  if (common.length === 0) return "";
  return common.slice(-1)[0] ?? "";
}

const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc"]);
const TEST_HINTS = ["__tests__", ".test.", ".spec."];

function classify(rows: NameStatusLine[]): { type: string; verb: string } {
  let added = 0, removed = 0, modified = 0, renamed = 0, docs = 0, tests = 0;
  for (const r of rows) {
    if (r.status === "A") added++;
    else if (r.status === "D") removed++;
    else if (r.status === "M") modified++;
    else if (r.status === "R") renamed++;
    const ext = (r.path.match(/\.([^./]+)$/)?.[1] ?? "").toLowerCase();
    if (DOC_EXTS.has(ext)) docs++;
    if (TEST_HINTS.some((h) => r.path.includes(h))) tests++;
  }
  const total = rows.length;
  let type = "chore";
  if (total > 0 && docs / total >= 0.8) type = "docs";
  else if (total > 0 && tests / total >= 0.8) type = "test";
  else if (added > modified + renamed && removed === 0) type = "feat";
  else if (removed > added) type = "refactor";
  else if (modified > 0) type = "fix";
  const verb =
    added > 0 && modified === 0 && removed === 0 && renamed === 0 ? "add"
    : removed > 0 && added === 0 && modified === 0 && renamed === 0 ? "remove"
    : renamed > 0 && added === 0 && removed === 0 ? "rename"
    : "update";
  return { type, verb };
}

function buildMessage(rows: NameStatusLine[]): string {
  if (rows.length === 0) return "chore: no changes";
  const scope = deriveScope(rows.map((r) => r.path));
  const { type, verb } = classify(rows);
  const fileWord = rows.length === 1 ? "file" : "files";
  const focus = rows.length === 1
    ? rows[0].path.split("/").slice(-1)[0]
    : `${rows.length} ${fileWord}`;
  const title = scope ? `${type}(${scope}): ${verb} ${focus}` : `${type}: ${verb} ${focus}`;
  const CAP = 8;
  const shown = rows.slice(0, CAP);
  const overflow = rows.length - shown.length;
  const bullets = shown.map((r) => {
    if (r.status === "R" && r.oldPath) return `- rename ${r.oldPath} → ${r.path}`;
    const v =
      r.status === "A" ? "add"
      : r.status === "D" ? "remove"
      : r.status === "M" ? "update"
      : r.status === "T" ? "change mode of"
      : r.status === "C" ? "copy to" : "touch";
    return `- ${v} ${r.path}`;
  });
  if (overflow > 0) bullets.push(`- …and ${overflow} more`);
  return `${title}\n\n${bullets.join("\n")}`;
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) return badRequest("invalid app name");
  const app = getApp(name);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return NextResponse.json({ error: "not a git repo", cwd }, { status: 404 });
  }

  try {
    const headRes = await execFileP("git", ["diff", "--name-status", "-M", "HEAD"], {
      cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const wtRes = await execFileP("git", ["diff", "--name-status", "-M"], {
      cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const untrackedRes = await execFileP("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    const seen = new Set<string>();
    const rows: NameStatusLine[] = [];
    for (const line of [
      ...parseNameStatus(headRes.stdout.toString()),
      ...parseNameStatus(wtRes.stdout.toString()),
    ]) {
      if (seen.has(line.path)) continue;
      seen.add(line.path);
      rows.push(line);
    }
    for (const path of untrackedRes.stdout.toString().split("\n")) {
      const p = path.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      rows.push({ status: "A", path: p });
    }
    return NextResponse.json({ message: buildMessage(rows), fileCount: rows.length, cwd });
  } catch (err) {
    return NextResponse.json(
      { error: "git diff failed", detail: safeErrorMessage(err, "unknown"), cwd },
      { status: 500 },
    );
  }
}
