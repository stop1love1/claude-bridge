/**
 * Read a text file under a registered app root (for Source code preview).
 *
 *   GET /api/apps/<segment>/file?path=relative/path/to/file.ts
 *
 * Caps size, rejects traversal, and refuses likely-binary content
 * (NUL in the scanned prefix).
 */
import { NextResponse, type NextRequest } from "next/server";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024;
const BINARY_SCAN = 8192;

type Ctx = { params: Promise<{ name: string }> };

function parseRelFile(raw: string | null): { ok: true; parts: string[] } | { ok: false } {
  if (raw == null || raw === "" || raw === ".") return { ok: false };
  const s = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return { ok: false };
  const parts = s.split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "." || p === "..") return { ok: false };
    if (p.includes("\0")) return { ok: false };
    if (p.length > 240) return { ok: false };
  }
  if (parts.length === 0 || parts.length > 64) return { ok: false };
  return { ok: true, parts };
}

function absoluteFileUnderApp(appRoot: string, parts: string[]): string | null {
  const root = resolve(appRoot);
  const target = resolve(join(root, ...parts));
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) return null;
  return target;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(BINARY_SCAN, buf.length);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) {
    return NextResponse.json({ error: "app not found" }, { status: 404 });
  }
  const parsed = parseRelFile(req.nextUrl.searchParams.get("path"));
  if (!parsed.ok) return badRequest("invalid path");

  const abs = absoluteFileUnderApp(app.path, parsed.parts);
  if (!abs) return badRequest("path outside app root");
  if (!existsSync(abs)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return NextResponse.json({ error: "stat failed" }, { status: 500 });
  }
  if (!st.isFile()) {
    return NextResponse.json({ error: "not a file" }, { status: 400 });
  }

  const rel = parsed.parts.join("/");
  const toRead = Math.min(st.size, MAX_BYTES);
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(toRead);
    readSync(fd, buf, 0, toRead, 0);
    if (looksBinary(buf)) {
      return NextResponse.json(
        { error: "binary-or-non-utf8", path: rel, hint: "File appears binary; preview skipped." },
        { status: 415 },
      );
    }
    const content = buf.toString("utf8");
    return NextResponse.json({
      path: rel,
      content,
      size: st.size,
      truncated: st.size > toRead,
    });
  } finally {
    closeSync(fd);
  }
}
