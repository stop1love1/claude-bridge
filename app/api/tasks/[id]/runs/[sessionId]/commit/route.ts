import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { DEFAULT_GIT_SETTINGS, getApp } from "@/libs/apps";
import { autoCommitAndPush } from "@/libs/gitOps";
import { readMeta } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";
import { verifyRequestActor } from "@/libs/auth";
import { resolveRunCwd } from "@/libs/runWorkingTree";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

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
  const cwd = resolveRunCwd(run, app);
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
