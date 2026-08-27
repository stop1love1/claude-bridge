import { type NextRequest } from "next/server";
import { existsSync, statSync, createReadStream } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { isValidAppName } from "@/libs/apps";

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

export async function GET(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) return new Response("invalid app name", { status: 400 });

  const md = readBridgeMd();
  const repoCwd = resolveRepoCwd(md, BRIDGE_ROOT, name);
  if (!repoCwd) return new Response("unknown repo", { status: 404 });

  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw || raw.includes("\0")) return new Response("invalid path", { status: 400 });

  const target = isAbsolute(raw)
    ? resolve(/* turbopackIgnore: true */ raw)
    : resolve(/* turbopackIgnore: true */ repoCwd, raw);
  if (!isInside(resolve(/* turbopackIgnore: true */ repoCwd), target)) {
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
