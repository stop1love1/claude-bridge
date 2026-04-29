import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readMeta } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import {
  badRequest,
  isValidAgentRole,
  isValidRepoLabel,
  isValidSessionId,
} from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sessionId: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, sessionId } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const run = meta.runs.find((r) => r.sessionId === sessionId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  // CRIT-5 belt-and-suspenders: even though /link + /agents now reject
  // dirty role/repo at write time, meta.json files written before this
  // patch could still contain something nasty. Re-validate before
  // templating into a filename, and confirm the resolved path stays
  // inside the task directory.
  if (!isValidAgentRole(run.role) || !isValidRepoLabel(run.repo)) {
    return NextResponse.json({ error: "run has invalid role/repo" }, { status: 500 });
  }
  const fileName = `${run.role}-${run.repo}.prompt.txt`;
  if (basename(fileName) !== fileName) {
    return NextResponse.json({ error: "run has invalid filename" }, { status: 500 });
  }
  const file = join(dir, fileName);
  const dirAbs = resolve(dir);
  const fileAbs = resolve(file);
  if (!fileAbs.startsWith(dirAbs)) {
    return NextResponse.json({ error: "outside task dir" }, { status: 500 });
  }
  if (!existsSync(file)) return NextResponse.json({ error: "prompt not saved" }, { status: 404 });
  const prompt = readFileSync(file, "utf8");
  return NextResponse.json({ prompt });
}
