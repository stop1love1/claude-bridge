import { NextResponse, type NextRequest } from "next/server";
import { readdirSync, readFileSync } from "node:fs";
import { basename as pathBasename, join, relative } from "node:path";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";

export const dynamic = "force-dynamic";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", "dist", "build",
  "out", "coverage", ".nuxt", ".output", "target", "vendor", ".idea",
  ".vscode", ".DS_Store",
]);
const HARD_CAP = 4000;
const MAX_RESULTS = 50;

function* walk(root: string): IterableIterator<string> {
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        yield p;
        if (++visited > HARD_CAP) return;
      }
    }
  }
}

type Ctx = { params: Promise<{ name: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").toLowerCase();

  const md = readFileSync(BRIDGE_MD, "utf8");
  const repoPath = resolveRepoCwd(md, BRIDGE_ROOT, name);
  if (!repoPath) return NextResponse.json({ error: "unknown repo" }, { status: 404 });

  const matches: Array<{ rel: string; path: string }> = [];
  for (const f of walk(repoPath)) {
    const rel = relative(repoPath, f).replace(/\\/g, "/");
    const lower = rel.toLowerCase();
    if (!q || lower.includes(q)) {
      matches.push({ rel, path: f });
    }
  }

  matches.sort((a, b) => {
    if (q) {
      const aBase = pathBasename(a.rel).toLowerCase().includes(q);
      const bBase = pathBasename(b.rel).toLowerCase().includes(q);
      if (aBase !== bBase) return aBase ? -1 : 1;
    }
    return a.rel.length - b.rel.length;
  });
  return NextResponse.json(matches.slice(0, MAX_RESULTS));
}
