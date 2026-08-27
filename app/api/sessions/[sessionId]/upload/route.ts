import { NextResponse, type NextRequest } from "next/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_ROOT } from "@/libs/paths";
import { badRequest, isValidSessionId } from "@/libs/validate";
import {
  MAX_UPLOAD_BYTES,
  assertInsideUploadDir,
  validateUploadName,
} from "@/libs/uploadGuards";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const lenHeader = req.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
      return NextResponse.json(
        { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` },
        { status: 413 },
      );
    }
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const guard = validateUploadName(file.name || "upload.bin");
  if (!guard.ok) {
    switch (guard.reason) {
      case "empty-name":
        return NextResponse.json({ error: "file name required" }, { status: 400 });
      case "blocked-extension":
        return NextResponse.json(
          { error: `extension not allowed: ${guard.detail}` },
          { status: 415 },
        );
      case "reserved-name":
        return NextResponse.json(
          { error: `reserved device name: ${guard.detail}` },
          { status: 400 },
        );
      case "outside-upload-dir":
        return NextResponse.json({ error: "invalid file name" }, { status: 400 });
    }
  }
  const safeName = guard.sanitized;

  const dir = join(BRIDGE_ROOT, ".uploads", sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, safeName);
  if (!assertInsideUploadDir(dir, filePath)) {
    return NextResponse.json({ error: "invalid file name" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(filePath, buf);
  return NextResponse.json({
    path: filePath,
    name: safeName,
    size: buf.length,
    url: `/api/uploads/${sessionId}/${encodeURIComponent(safeName)}`,
    mime: file.type || null,
  });
}
