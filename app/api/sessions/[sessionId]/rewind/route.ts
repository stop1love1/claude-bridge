import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { projectDirFor } from "@/libs/sessions";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { getChild } from "@/libs/spawnRegistry";
import { isAlive } from "@/libs/sessionEvents";
import { ok } from "@/libs/apiResponse";
import { truncateTranscript } from "@/libs/transcriptRewind";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

interface RewindBody {
  repo: string;
  uuid: string;
  /** false drops the target entry too — what editing a message needs. */
  inclusive?: boolean;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  const body = (await req.json()) as Partial<RewindBody>;
  if (!body.repo || !body.uuid) {
    return NextResponse.json({ error: "repo and uuid required" }, { status: 400 });
  }

  if (getChild(sessionId) || isAlive(sessionId)) {
    return NextResponse.json(
      { error: "session is still running — stop the run before rewinding" },
      { status: 409 },
    );
  }

  const md = readBridgeMd();
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, body.repo);
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 400 });

  const file = join(projectDirFor(cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return NextResponse.json({ error: "session file not found" }, { status: 404 });

  const content = readFileSync(file, "utf8");
  const result = truncateTranscript(content, body.uuid, {
    inclusive: body.inclusive !== false,
  });
  if (!result) {
    return NextResponse.json({ error: "uuid not found in session" }, { status: 404 });
  }

  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, result.payload);
  renameSync(tmp, file);
  return ok({ kept: result.kept, dropped: result.dropped });
}
