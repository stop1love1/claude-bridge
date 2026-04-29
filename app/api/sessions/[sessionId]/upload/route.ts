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

/**
 * Drop an uploaded file into `<bridge>/.uploads/<sessionId>/`. We don't
 * stream it back to the model directly — we hand the absolute path to
 * the user's message and let `claude` Read it. Works for text, code,
 * and (with claude's native multimodal Read) images.
 *
 * Trust model: a name that lands here is later passed to `Read` / `Bash`
 * by the model. We block executable extensions, Windows reserved
 * device names, and surrounding `.` / space tricks (see
 * `libs/uploadGuards.ts`) to keep that boundary safe.
 *
 * `request.formData()` still buffers the body into memory before
 * `file.size` is reachable, but we now refuse the request up-front
 * when the `Content-Length` header alone exceeds the cap (`MAX_UPLOAD_BYTES`
 * + a generous slack for multipart boundary overhead). That closes
 * the trivial DoS where a hostile client streams gigabytes of "uploads"
 * just to make us allocate. A switch to streaming multipart parsing
 * (Busboy) is still the proper long-term fix for chunked / unknown-
 * length requests.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  // Tighter than the previous `^[a-z0-9-]{8,}$/i` check — a session id
  // is always a UUID v4 produced by `randomUUID()`. Routing through the
  // shared validator keeps the gate consistent across endpoints.
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  // M1 pre-check: short-circuit oversized uploads on the header alone
  // so we never allocate the buffer for the 10 GiB body case. We add
  // a 64 KiB slack to MAX_UPLOAD_BYTES because multipart/form-data
  // wraps the file in boundary lines, headers, and trailing CRLFs.
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
  // Defense in depth: even after sanitization, refuse to write if the
  // resolved path escapes the per-session upload dir. Catches any
  // future regression where the sanitization is loosened.
  if (!assertInsideUploadDir(dir, filePath)) {
    return NextResponse.json({ error: "invalid file name" }, { status: 400 });
  }

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
