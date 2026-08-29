import { NextResponse, type NextRequest } from "next/server";
import { readFileUnderRoot } from "@/libs/readFileUnderRoot";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/**
 * Reads a text file out of any repo the bridge knows — including the bridge
 * itself, which is a repo but not a registered app, so the per-app route
 * cannot reach it. Backs the file references agents write in the transcript.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const cwd = resolveRepoCwd(readBridgeMd(), BRIDGE_ROOT, name);
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 404 });

  const r = readFileUnderRoot(cwd, req.nextUrl.searchParams.get("path"));
  if (!r.ok) {
    switch (r.reason) {
      case "invalid-path":
        return badRequest("invalid path");
      case "not-found":
        return NextResponse.json({ error: "not found" }, { status: 404 });
      case "not-a-file":
        return NextResponse.json({ error: "not a file" }, { status: 400 });
      case "binary":
        return NextResponse.json(
          { error: "binary-or-non-utf8", hint: "File appears binary; preview skipped." },
          { status: 415 },
        );
      default:
        return NextResponse.json({ error: "stat failed" }, { status: 500 });
    }
  }
  return NextResponse.json({
    path: r.path,
    content: r.content,
    size: r.size,
    truncated: r.truncated,
  });
}
