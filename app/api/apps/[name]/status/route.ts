/**
 * Git status snapshot for an app: current branch, upstream tracking,
 * ahead/behind counts, and a porcelain summary (modified / added /
 * deleted / untracked file counts).
 *
 * Cheap one-shot — runs three small `git` commands in parallel,
 * 5s combined timeout. Used by the app detail page header so the
 * operator sees branch + dirty/clean state without leaving the row.
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

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) return badRequest("invalid app name");
  const app = getApp(name);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd)) {
    return NextResponse.json({ error: "app folder is missing", cwd }, { status: 404 });
  }
  if (!existsSync(join(cwd, ".git"))) {
    return NextResponse.json({ error: "not a git repo", cwd }, { status: 409 });
  }

  try {
    // Branch + upstream + ahead/behind in one shot via porcelain v2.
    const [statusRes, logRes] = await Promise.all([
      execFileP("git", ["status", "--porcelain=v2", "--branch"], {
        cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
      }),
      execFileP("git", ["rev-parse", "HEAD"], {
        cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024,
      }).catch(() => ({ stdout: "", stderr: "" })),
    ]);

    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    let modified = 0, added = 0, deleted = 0, untracked = 0, renamed = 0;

    for (const line of statusRes.stdout.toString().split("\n")) {
      if (line.startsWith("# branch.head ")) {
        branch = line.slice("# branch.head ".length).trim();
      } else if (line.startsWith("# branch.upstream ")) {
        upstream = line.slice("# branch.upstream ".length).trim();
      } else if (line.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
      } else if (line.startsWith("1 ")) {
        // Modified tracked file. The 2 XY chars after `1 ` describe
        // staged + unstaged status.
        const xy = line.slice(2, 4);
        if (xy.includes("A")) added++;
        else if (xy.includes("D")) deleted++;
        else modified++;
      } else if (line.startsWith("2 ")) {
        renamed++;
      } else if (line.startsWith("?")) {
        untracked++;
      }
    }

    return NextResponse.json({
      cwd,
      branch,
      upstream,
      ahead,
      behind,
      head: logRes.stdout.toString().trim() || null,
      counts: { modified, added, deleted, renamed, untracked },
      clean: modified + added + deleted + renamed + untracked === 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "git status failed", detail: safeErrorMessage(err, "unknown"), cwd },
      { status: 500 },
    );
  }
}
