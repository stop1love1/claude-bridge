import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDirFor } from "@/lib/sessions";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { badRequest, isValidSessionId } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

interface RewindBody {
  repo: string;
  /** Drop every entry whose `uuid` comes after this one. The targeted
   *  entry itself is kept — think "rewind to here, this is now my latest
   *  turn". */
  uuid: string;
}

/**
 * Truncate a session's .jsonl after a given entry uuid. The next time
 * the user resumes the session, claude sees the conversation as if the
 * later turns never happened — same idea as `/rewind` in claude code.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  const body = (await req.json()) as Partial<RewindBody>;
  if (!body.repo || !body.uuid) {
    return NextResponse.json({ error: "repo and uuid required" }, { status: 400 });
  }

  const md = readFileSync(BRIDGE_MD, "utf8");
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, body.repo);
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 400 });

  const file = join(projectDirFor(cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return NextResponse.json({ error: "session file not found" }, { status: 404 });

  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  let cutoff = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const obj = JSON.parse(lines[i]) as { uuid?: string };
      if (obj.uuid === body.uuid) { cutoff = i; break; }
    } catch { /* skip malformed */ }
  }
  if (cutoff === -1) return NextResponse.json({ error: "uuid not found in session" }, { status: 404 });

  const kept = lines.slice(0, cutoff + 1).join("\n");
  writeFileSync(file, kept.endsWith("\n") ? kept : kept + "\n");
  return NextResponse.json({ ok: true, kept: cutoff + 1, dropped: lines.length - cutoff - 1 });
}
