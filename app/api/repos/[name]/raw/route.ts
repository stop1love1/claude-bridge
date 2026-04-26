import { type NextRequest } from "next/server";
import { existsSync, statSync, createReadStream, readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { isValidAppName } from "@/lib/apps";

export const dynamic = "force-dynamic";

const IMAGE_MIME: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".bmp":  "image/bmp",
  ".avif": "image/avif",
};

const MAX_BYTES = 8 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return !rel.split(sep).some((seg) => seg === "..");
}

type Ctx = { params: Promise<{ name: string }> };

/**
 * Serves an image file from inside a registered/known repo so the chat
 * UI can preview screenshots that a tool call (Read / Bash output)
 * referenced by relative path.
 *
 *   GET /api/repos/<name>/raw?path=<relative-or-absolute-path>
 *
 * Safety:
 *   - Repo must resolve via `resolveRepoCwd` (registered or sibling).
 *   - Resolved target must stay strictly inside the repo root.
 *   - Only image extensions are served (defensive — `nosniff` in
 *     headers stops the browser from running anything else even if a
 *     bug widened this list).
 *   - 8 MiB hard cap.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) return new Response("invalid app name", { status: 400 });

  const md = readFileSync(BRIDGE_MD, "utf8");
  const repoCwd = resolveRepoCwd(md, BRIDGE_ROOT, name);
  if (!repoCwd) return new Response("unknown repo", { status: 404 });

  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw || raw.includes("\0")) return new Response("invalid path", { status: 400 });

  // Accept either an absolute path (already inside the repo) or a path
  // relative to the repo root. Normalize to absolute and verify
  // containment before any disk access.
  const target = isAbsolute(raw) ? resolve(raw) : resolve(repoCwd, raw);
  if (!isInside(resolve(repoCwd), target)) {
    return new Response("outside repo", { status: 400 });
  }

  if (!existsSync(target)) return new Response("not found", { status: 404 });
  const stat = statSync(target);
  if (!stat.isFile()) return new Response("not a file", { status: 404 });
  if (stat.size > MAX_BYTES) return new Response("file too large", { status: 413 });

  const ext = extname(target).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return new Response("unsupported type", { status: 415 });

  const stream = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(stat.size),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
