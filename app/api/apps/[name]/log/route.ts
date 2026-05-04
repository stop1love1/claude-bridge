/**
 * Recent commit log for an app. Returns up to `limit` commits in
 * chronological-newest-first order with author, subject, and short
 * hash — what the operator needs to scan history without leaving
 * the bridge UI.
 *
 *   GET /api/apps/<name>/log?limit=20
 *
 * Format: `git log --pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e`
 * (unit separator + record separator) so subjects with arbitrary
 * punctuation parse cleanly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getApp } from "@/libs/apps";
import { badRequest } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

type Ctx = { params: Promise<{ name: string }> };

interface LogEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** Unix epoch seconds. */
  at: number;
  subject: string;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!name || name.length > 200) return badRequest("invalid app name");
  const app = getApp(name);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return NextResponse.json({ error: "app is not a git repo", cwd }, { status: 404 });
  }

  const limitRaw = req.nextUrl.searchParams.get("limit");
  let limit = limitRaw ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  try {
    const FMT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e";
    const res = await execFileP(
      "git",
      ["log", `--pretty=format:${FMT}`, `-n`, String(limit), "--no-color"],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const commits: LogEntry[] = [];
    for (const rec of res.stdout.toString().split("\x1e")) {
      const trimmed = rec.replace(/^\n+/, "");
      if (!trimmed) continue;
      const [sha, shortSha, author, email, at, subject] = trimmed.split("\x1f");
      if (!sha) continue;
      commits.push({
        sha,
        shortSha,
        author,
        email,
        at: parseInt(at, 10) || 0,
        subject: subject ?? "",
      });
    }
    return NextResponse.json({ cwd, commits });
  } catch (err) {
    return NextResponse.json(
      { error: "git log failed", detail: safeErrorMessage(err, "unknown"), cwd },
      { status: 500 },
    );
  }
}
