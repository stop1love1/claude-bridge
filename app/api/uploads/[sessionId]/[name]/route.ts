import { type NextRequest } from "next/server";
import { existsSync, statSync, createReadStream } from "node:fs";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { BRIDGE_ROOT } from "@/libs/paths";
import { isValidSessionId } from "@/libs/validate";
import { assertInsideUploadDir } from "@/libs/uploadGuards";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".pdf":  "application/pdf",
  ".txt":  "text/plain; charset=utf-8",
  ".md":   "text/plain; charset=utf-8",
  ".json": "application/json",
};

type Ctx = { params: Promise<{ sessionId: string; name: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sessionId, name } = await ctx.params;
  if (!isValidSessionId(sessionId)) {
    return new Response("invalid sessionId", { status: 400 });
  }
  const decoded = decodeURIComponent(name);
  if (!decoded || basename(decoded) !== decoded) {
    return new Response("invalid name", { status: 400 });
  }
  if (decoded.includes("\0")) {
    return new Response("invalid name", { status: 400 });
  }

  const dir = join(BRIDGE_ROOT, ".uploads", sessionId);
  const full = join(dir, decoded);
  if (!assertInsideUploadDir(dir, full)) {
    return new Response("outside upload dir", { status: 400 });
  }
  if (!existsSync(full)) return new Response("not found", { status: 404 });

  const stat = statSync(full);
  if (!stat.isFile()) return new Response("not a file", { status: 404 });

  const ext = extname(decoded).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>;

  const headers: Record<string, string> = {
    "content-type": mime,
    "content-length": String(stat.size),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  if (mime === "application/octet-stream") {
    const headerSafe = decoded.replace(/["\r\n]/g, "");
    headers["content-disposition"] = `attachment; filename="${headerSafe}"`;
  }
  return new Response(stream, { status: 200, headers });
}
