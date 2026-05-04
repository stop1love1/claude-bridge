/**
 * One-level directory listing under a registered app root. Used by the
 * app detail "Source code" tab for lazy tree expansion.
 *
 *   GET /api/apps/<segment>/tree?dir=relative/sub/path
 *
 * `dir` is optional (root when absent). Relative segments use `/`;
 * `..`, NUL, and absolute paths are rejected. Result paths are always
 * contained under `app.path`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";

/** Hard cap per directory listing (very large dirs return `truncated`). */
const MAX_ENTRIES = 100_000;

type Ctx = { params: Promise<{ name: string }> };

function parseRelDir(raw: string | null): { ok: true; parts: string[] } | { ok: false } {
  if (raw == null || raw === "" || raw === ".") return { ok: true, parts: [] };
  const s = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return { ok: true, parts: [] };
  const parts = s.split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "." || p === "..") return { ok: false };
    if (p.includes("\0")) return { ok: false };
    if (p.length > 240) return { ok: false };
  }
  if (parts.length > 64) return { ok: false };
  return { ok: true, parts };
}

function absoluteDirUnderApp(appRoot: string, parts: string[]): string | null {
  const root = resolve(appRoot);
  const target = parts.length === 0 ? root : resolve(join(root, ...parts));
  if (target === root) return target;
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!target.startsWith(prefix)) return null;
  return target;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) {
    return NextResponse.json({ error: "app not found" }, { status: 404 });
  }
  const parsed = parseRelDir(req.nextUrl.searchParams.get("dir"));
  if (!parsed.ok) return badRequest("invalid dir");
  const dirAbs = absoluteDirUnderApp(app.path, parsed.parts);
  if (!dirAbs) return badRequest("path outside app root");
  if (!existsSync(dirAbs)) {
    return NextResponse.json({ error: "directory not found" }, { status: 404 });
  }
  try {
    if (!statSync(dirAbs).isDirectory()) {
      return NextResponse.json({ error: "not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "stat failed" }, { status: 500 });
  }

  let dirents;
  try {
    dirents = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }

  const entries: Array<{ name: string; type: "dir" | "file" | "other" }> = [];
  for (const e of dirents) {
    const t = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
    entries.push({ name: e.name, type: t });
  }
  entries.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const rel = parsed.parts.join("/");
  return NextResponse.json({
    rel,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  });
}
