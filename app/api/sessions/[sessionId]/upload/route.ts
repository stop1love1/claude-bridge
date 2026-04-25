import { NextResponse, type NextRequest } from "next/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_ROOT } from "@/lib/paths";
import { badRequest, isValidSessionId } from "@/lib/validate";

export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB ceiling

type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * Drop an uploaded file into `<bridge>/.uploads/<sessionId>/`. We don't
 * stream it back to the model directly — we hand the absolute path to
 * the user's message and let `claude` Read it. Works for text, code,
 * and (with claude's native multimodal Read) images.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  // Tighter than the previous `^[a-z0-9-]{8,}$/i` check — a session id
  // is always a UUID v4 produced by `randomUUID()`. Routing through the
  // shared validator keeps the gate consistent across endpoints.
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (max ${MAX_BYTES} bytes)` }, { status: 413 });
  }
  const dir = join(BRIDGE_ROOT, ".uploads", sessionId);
  mkdirSync(dir, { recursive: true });
  const safeName = file.name.replace(/[\\/:*?"<>|]/g, "_") || "upload.bin";
  const filePath = join(dir, safeName);
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(filePath, buf);
  return NextResponse.json({
    path: filePath,
    name: safeName,
    size: buf.length,
    // Browser-accessible URL for the chat log to embed previews.
    url: `/api/uploads/${sessionId}/${encodeURIComponent(safeName)}`,
    mime: file.type || null,
  });
}
