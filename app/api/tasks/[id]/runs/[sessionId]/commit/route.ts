/**
 * Manual commit endpoint for a single run's worktree.
 *
 * The bridge already runs auto-commit + auto-push after every clean
 * child exit per `bridge.json.apps[].git`. This route exposes the
 * same primitive on demand so an operator reviewing a run's diff in
 * the UI can stage everything and commit with their own message
 * (or with one Claude generated client-side).
 *
 * Request body:
 *   { message: string, push?: boolean }
 *
 * Behavior:
 *   - Resolves the run's working tree (worktree if still on disk,
 *     otherwise the live app tree). Same logic as the diff route so
 *     the operator commits exactly what they reviewed.
 *   - Stages every change (`git add -A`), commits with the supplied
 *     message, and optionally pushes to the tracked upstream.
 *   - "No changes to commit" is a success outcome (returns ok with
 *     an explanatory message), not a 4xx — the caller doesn't need
 *     to special-case it.
 *   - Protected branches (`main`, `master`, `develop`, …) follow the
 *     same `tryPush` rules as auto-commit: commit succeeds, push is
 *     skipped with a warning unless the operator explicitly opted in
 *     via the app's `branchMode`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DEFAULT_GIT_SETTINGS, getApp } from "@/libs/apps";
import { autoCommitAndPush } from "@/libs/gitOps";
import { readMeta } from "@/libs/meta";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

function isUnderAppRoot(appPath: string, candidate: string): boolean {
  const a = resolve(appPath);
  const c = resolve(candidate);
  if (a === c) return true;
  return c.startsWith(a + sep) || c.startsWith(a + "/");
}

interface CommitBody {
  message: string;
  push?: boolean;
}

const MAX_MESSAGE_BYTES = 4 * 1024;

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, sessionId } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  let body: CommitBody;
  try {
    body = (await req.json()) as CommitBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  const message = (body.message ?? "").trim();
  if (!message) return badRequest("commit message is required");
  if (message.length > MAX_MESSAGE_BYTES) {
    return badRequest(`message too long (max ${MAX_MESSAGE_BYTES} bytes)`);
  }
  const push = !!body.push;

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

  try {
    // Borrow the rest of the app's git policy (branch mode, worktree
    // mode, merge target, integration mode) so the commit honors the
    // operator's protected-branch settings, but force-enable
    // `autoCommit` and respect the caller's push intent — this is a
    // user-initiated commit, they explicitly asked for it.
    const result = await autoCommitAndPush(
      cwd,
      {
        ...(app?.git ?? DEFAULT_GIT_SETTINGS),
        autoCommit: true,
        autoPush: push,
      },
      message,
    );
    return NextResponse.json({ ...result, cwd });
  } catch (err) {
    return NextResponse.json(
      { error: "commit failed", detail: safeErrorMessage(err, "unknown") },
      { status: 500 },
    );
  }
}
