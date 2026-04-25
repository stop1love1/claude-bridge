import { type NextRequest } from "next/server";
import { existsSync, statSync, createReadStream } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { BRIDGE_ROOT } from "@/lib/paths";
import { isValidSessionId } from "@/lib/validate";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".pdf":  "application/pdf",
  ".txt":  "text/plain; charset=utf-8",
  ".md":   "text/plain; charset=utf-8",
  ".json": "application/json",
};

type Ctx = { params: Promise<{ sessionId: string; name: string }> };

/**
 * Serves a file the user uploaded into `<bridge>/.uploads/<sessionId>/`.
 * The chat log embeds image previews via this endpoint so the user can
 * see what they pasted/attached without leaving the page.
 *
 *   GET /api/uploads/<sessionId>/<filename>
 *
 * Path traversal is blocked: the resolved path must stay under the
 * session's upload directory.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sessionId, name } = await ctx.params;
  if (!isValidSessionId(sessionId)) {
    return new Response("invalid sessionId", { status: 400 });
  }
  const decoded = decodeURIComponent(name);
  // basename() strips any traversal segment / prefix the client could
  // smuggle in; if the result differs from the original, reject — we
  // refuse to second-guess what the caller actually meant.
  if (!decoded || basename(decoded) !== decoded) {
    return new Response("invalid name", { status: 400 });
  }
  if (decoded.includes("\0")) {
    return new Response("invalid name", { status: 400 });
  }

  const dir = join(BRIDGE_ROOT, ".uploads", sessionId);
  const full = normalize(join(dir, decoded));
  if (!full.startsWith(dir)) {
    return new Response("outside upload dir", { status: 400 });
  }
  if (!existsSync(full)) return new Response("not found", { status: 404 });

  const stat = statSync(full);
  if (!stat.isFile()) return new Response("not a file", { status: 404 });

  const mime = MIME[extname(decoded).toLowerCase()] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(stat.size),
      "cache-control": "private, max-age=3600",
    },
  });
}
