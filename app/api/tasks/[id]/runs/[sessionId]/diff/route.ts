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
import { safeErrorMessage } from "@/libs/errorResponse";
import { badRequest, isValidSessionId } from "@/libs/validate";

function isUnderAppRoot(appPath: string, candidate: string): boolean {
  const a = resolve(appPath);
  const c = resolve(candidate);
  if (a === c) return true;
  return c.startsWith(a + sep) || c.startsWith(a + "/");
}

export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);
const DIFF_TIMEOUT_MS = 10_000;
const DIFF_CAP_BYTES = 256 * 1024;

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

async function gitDiff(
  cwd: string,
): Promise<{ diff: string; truncated: boolean } | { error: string }> {
  try {
    const head = await execFileP(
      "git",
      ["diff", "HEAD", "--no-color"],
      {
        cwd,
        timeout: DIFF_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: DIFF_CAP_BYTES * 2,
      },
    );
    let body = head.stdout.toString();
    if (!body.trim()) {
      const plain = await execFileP(
        "git",
        ["diff", "--no-color"],
        {
          cwd,
          timeout: DIFF_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: DIFF_CAP_BYTES * 2,
        },
      );
      body = plain.stdout.toString();
    }
    let truncated = false;
    if (body.length > DIFF_CAP_BYTES) {
      body =
        body.slice(0, DIFF_CAP_BYTES) +
        `\n\n…(bridge: diff truncated at ${DIFF_CAP_BYTES} bytes)`;
      truncated = true;
    }
    return { diff: body, truncated };
  } catch (err) {
    return { error: safeErrorMessage(err, "git diff failed") };
  }
}

export async function GET(_req: NextRequest, ctx: Ctx) {
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
  let kind: "worktree" | "live" = "live";
  if (
    run.worktreePath &&
    app &&
    isUnderAppRoot(app.path, run.worktreePath) &&
    existsSync(run.worktreePath)
  ) {
    cwd = run.worktreePath;
    kind = "worktree";
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
      {
        error: "cannot resolve a working tree for this run",
        hint: "worktree may have been pruned and the live repo is unregistered",
      },
      { status: 404 },
    );
  }

  if (!existsSync(join(cwd, ".git"))) {
    return NextResponse.json(
      { error: "working tree is not a git repo", cwd },
      { status: 409 },
    );
  }

  const result = await gitDiff(cwd);
  if ("error" in result) {
    return NextResponse.json(
      { error: "git diff failed", detail: result.error, cwd },
      { status: 500 },
    );
  }
  return NextResponse.json({
    kind,
    cwd,
    diff: result.diff,
    truncated: result.truncated || undefined,
  });
}
