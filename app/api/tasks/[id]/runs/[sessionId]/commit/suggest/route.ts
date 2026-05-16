/**
 * Heuristic commit-message suggester for a single run's worktree.
 *
 * Stays purely local — no API calls — so the UI's "auto-generate"
 * button is fast and works offline. The output mirrors Conventional
 * Commits when there's a clear single scope, falling back to a
 * `chore: …` summary when the change spans many directories.
 *
 * Inputs the heuristic considers:
 *   - File counts per status (added / deleted / renamed / modified)
 *     to pick the verb (`add` / `remove` / `rename` / `update`).
 *   - The deepest common directory across changed files to derive
 *     the scope. We bias toward subdirectory names that look like
 *     features (`auth`, `finance`) over generic top-levels (`src`,
 *     `app`) by stripping a small prefix list.
 *   - File-extension distribution to flag refactor / docs / test
 *     commits when ≥80% of changes hit one category.
 *
 * Tradeoff: the suggestion is intentionally a one-liner stub. The
 * operator is expected to skim the diff and edit if needed; the UI
 * paints the field as a placeholder so they always feel ownership
 * over what gets committed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { getApp } from "@/libs/apps";
import { readMeta } from "@/libs/meta";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";
import { generateCommitMessageWithLLM } from "@/libs/commitMessage";

export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const TIMEOUT_MS = 5_000;

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

function isUnderAppRoot(appPath: string, candidate: string): boolean {
  const a = resolve(appPath);
  const c = resolve(candidate);
  if (a === c) return true;
  return c.startsWith(a + sep) || c.startsWith(a + "/");
}

interface NameStatusLine {
  status: "A" | "D" | "M" | "R" | "T" | "C";
  path: string;
  /** Pre-rename path when status === "R". */
  oldPath?: string;
}

/**
 * Parse `git diff --name-status -M HEAD`. Format per line:
 *   `<S>\t<path>` for plain statuses
 *   `R<sim>\t<oldPath>\t<newPath>` for renames (`R100`, `R087`, …)
 */
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
    if (
      status === "A" || status === "D" || status === "M" ||
      status === "T" || status === "C"
    ) {
      rows.push({ status: status as NameStatusLine["status"], path: parts[1] ?? "" });
    }
  }
  return rows;
}

/**
 * Common-prefix-of-file-paths up to a directory boundary. Returns
 * `""` when the files don't share any non-trivial parent. Bias away
 * from generic top-levels (`src/`, `app/`, `lib/`) by skipping them
 * when there's a more specific deeper folder shared by every file.
 */
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
  // Take the deepest 1-2 segments as the scope label so something
  // like `app/_components/SessionLog/views.tsx` becomes "SessionLog".
  return common.slice(-1)[0] ?? "";
}

const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc"]);
const TEST_HINTS = ["__tests__", ".test.", ".spec."];

function classify(rows: NameStatusLine[]): { type: string; verb: string } {
  let added = 0, removed = 0, modified = 0, renamed = 0;
  let docs = 0, tests = 0;
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
  // Conventional-Commits type
  let type = "chore";
  if (total > 0 && docs / total >= 0.8) type = "docs";
  else if (total > 0 && tests / total >= 0.8) type = "test";
  else if (added > modified + renamed && removed === 0) type = "feat";
  else if (removed > added) type = "refactor";
  else if (modified > 0) type = "fix";

  // Verb that summarizes the change shape (used in title body).
  const verb =
    added > 0 && modified === 0 && removed === 0 && renamed === 0
      ? "add"
      : removed > 0 && added === 0 && modified === 0 && renamed === 0
        ? "remove"
        : renamed > 0 && added === 0 && removed === 0
          ? "rename"
          : "update";

  return { type, verb };
}

function buildMessage(rows: NameStatusLine[]): string {
  if (rows.length === 0) return "chore: no changes";
  const scope = deriveScope(rows.map((r) => r.path));
  const { type, verb } = classify(rows);

  // Title.
  const fileWord = rows.length === 1 ? "file" : "files";
  const focus =
    rows.length === 1
      ? rows[0].path.split("/").slice(-1)[0]
      : `${rows.length} ${fileWord}`;
  const title = scope
    ? `${type}(${scope}): ${verb} ${focus}`
    : `${type}: ${verb} ${focus}`;

  // Body — bullet list capped at 8 entries so the message stays
  // skimmable. Anything beyond gets summarized as a count.
  const CAP = 8;
  const shown = rows.slice(0, CAP);
  const overflow = rows.length - shown.length;
  const bullets = shown.map((r) => {
    if (r.status === "R" && r.oldPath) return `- rename ${r.oldPath} → ${r.path}`;
    const verbForRow =
      r.status === "A" ? "add" :
      r.status === "D" ? "remove" :
      r.status === "M" ? "update" :
      r.status === "T" ? "change mode of" :
      r.status === "C" ? "copy to" : "touch";
    return `- ${verbForRow} ${r.path}`;
  });
  if (overflow > 0) bullets.push(`- …and ${overflow} more`);
  return `${title}\n\n${bullets.join("\n")}`;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, sessionId } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const run = meta.runs.find((r) => r.sessionId === sessionId);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const app = getApp(run.repo);
  let cwd: string | null = null;
  if (
    run.worktreePath &&
    app &&
    isUnderAppRoot(app.path, run.worktreePath) &&
    existsSync(run.worktreePath)
  ) {
    cwd = run.worktreePath;
  } else if (app && existsSync(app.path)) {
    cwd = app.path;
  } else {
    const md = readBridgeMd();
    if (md) {
      const resolved = resolveRepoCwd(md, BRIDGE_ROOT, run.repo);
      if (resolved && existsSync(resolved)) cwd = resolved;
    }
  }
  if (!cwd) {
    return NextResponse.json(
      { error: "cannot resolve a working tree for this run" },
      { status: 404 },
    );
  }

  // `?heuristic=1` → skip the LLM entirely (UI toggle / tests).
  const wantHeuristic = req.nextUrl.searchParams.get("heuristic") === "1";

  try {
    // `--name-status -M` so renames are detected as `R`. Combine
    // HEAD diff (committed-since-HEAD changes) with the working-
    // tree diff (uncommitted edits) so the suggestion covers
    // everything `git add -A` would stage.
    const headRes = await execFileP(
      "git",
      ["diff", "--name-status", "-M", "HEAD"],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const wtRes = await execFileP(
      "git",
      ["diff", "--name-status", "-M"],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const untrackedRes = await execFileP(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
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

    if (rows.length === 0) {
      return NextResponse.json({
        message: "chore: no changes",
        fileCount: 0,
        cwd,
        source: "heuristic",
      });
    }

    // Try LLM first (unless explicitly disabled). Pass the task title
    // so the model has the "what was supposed to ship" context — it
    // still grounds the subject in the actual diff, but the title
    // helps disambiguate when the diff alone is genuinely ambiguous.
    if (!wantHeuristic) {
      const llm = await generateCommitMessageWithLLM({
        cwd,
        taskTitle: meta.taskTitle,
      });
      if (llm) {
        return NextResponse.json({
          message: llm.message,
          fileCount: rows.length,
          cwd,
          source: "llm",
        });
      }
    }

    return NextResponse.json({
      message: buildMessage(rows),
      fileCount: rows.length,
      cwd,
      source: "heuristic",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "git diff failed", detail: safeErrorMessage(err, "unknown") },
      { status: 500 },
    );
  }
}
