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
import { verifyRequestActor } from "@/libs/auth";

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
  let push = !!body.push;
  const actor = verifyRequestActor(req);
  if (actor?.kind === "guest" && !actor.grants.push) push = false;

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
