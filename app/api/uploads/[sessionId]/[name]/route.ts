import { type NextRequest } from "next/server";
import { existsSync, statSync, createReadStream } from "node:fs";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { BRIDGE_ROOT } from "@/libs/paths";
import { isValidSessionId } from "@/libs/validate";
import { assertInsideUploadDir } from "@/libs/uploadGuards";

export const dynamic = "force-dynamic";

// Note: `.svg` is INTENTIONALLY absent. uploadGuards.ts blocks SVG
// uploads via BLOCKED_EXTENSIONS, so a legitimate upload pipeline can
// never produce one — but a stray file dropped into `.uploads/` (test
// fixture, manual paste) would otherwise be served as
// `image/svg+xml` and could carry inline `<script>` that runs in the
// bridge's origin. Without an entry here it falls through to
// `application/octet-stream` and the browser will download rather
// than render.
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
  const full = join(dir, decoded);
  // Use the shared helper so the serving route enforces the SAME
  // containment rule as the write route — `resolve()` + `sep`-suffixed
  // prefix check rules out the `/uploads/abc` vs `/uploads/abc-evil/`
  // sibling-prefix attack a bare `startsWith(dir)` would let through.
  if (!assertInsideUploadDir(dir, full)) {
    return new Response("outside upload dir", { status: 400 });
  }
  if (!existsSync(full)) return new Response("not found", { status: 404 });

  const stat = statSync(full);
  if (!stat.isFile()) return new Response("not a file", { status: 404 });

  const ext = extname(decoded).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>;

  // L1: defensive headers on user-uploaded content.
  //   - `nosniff` on every response prevents the browser from
  //     MIME-sniffing a `.txt` into HTML and running an XSS payload
  //     that was dragged into the upload dir.
  //   - `attachment` for any extension that fell back to
  //     application/octet-stream (i.e. anything not in our explicit
  //     allow-list above). SVG, HTML, and friends therefore download
  //     rather than render in the bridge's origin context.
  const headers: Record<string, string> = {
    "content-type": mime,
    "content-length": String(stat.size),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  if (mime === "application/octet-stream") {
    // Strip CR/LF (and quotes) from the filename before injecting it
    // into the header. Node 18+ already blocks CR/LF in header values
    // at runtime, but doing it here turns a 500 into a clean response
    // and matches the defense-in-depth pattern used elsewhere.
    const headerSafe = decoded.replace(/["\r\n]/g, "");
    headers["content-disposition"] = `attachment; filename="${headerSafe}"`;
  }
  return new Response(stream, { status: 200, headers });
}
