/**
 * Working-tree diff for an app — covers everything `git add -A` would
 * stage (HEAD diff for committed-since-HEAD changes, working-tree diff
 * for uncommitted edits). Same shape as the per-run diff endpoint so
 * the existing `DiffViewer` component can render it without changes.
 *
 *   GET /api/apps/<name>/diff
 *   → { kind: "live", cwd, diff, truncated? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const TIMEOUT_MS = 10_000;
const CAP_BYTES = 256 * 1024;

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return NextResponse.json({ error: "app is not a git repo", cwd }, { status: 404 });
  }

  try {
    const head = await execFileP(
      "git",
      ["diff", "HEAD", "--no-color"],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: CAP_BYTES * 2 },
    );
    let body = head.stdout.toString();
    if (!body.trim()) {
      const plain = await execFileP(
        "git",
        ["diff", "--no-color"],
        { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: CAP_BYTES * 2 },
      );
      body = plain.stdout.toString();
    }
    let truncated = false;
    if (body.length > CAP_BYTES) {
      body =
        body.slice(0, CAP_BYTES) +
        `\n\n…(bridge: diff truncated at ${CAP_BYTES} bytes)`;
      truncated = true;
    }
    return NextResponse.json({
      kind: "live" as const,
      cwd,
      diff: body,
      truncated: truncated || undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "git diff failed", detail: safeErrorMessage(err, "unknown"), cwd },
      { status: 500 },
    );
  }
}
