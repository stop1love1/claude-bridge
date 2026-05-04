/**
 * P5/G1 — per-app memory.md API.
 *
 *   GET  → returns the current memory entries (top 50, JSON array).
 *   POST → appends a new entry. Body: `{ "entry": "When X → do Y because Z" }`.
 *
 * Storage lives at `<appPath>/.bridge/memory.md`. The bridge owns the
 * file shape (see `libs/memory.ts`); this route just validates the
 * boundary.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { appendMemory, topMemoryEntries } from "@/libs/memory";

export const dynamic = "force-dynamic";

const MAX_ENTRY_CHARS = 1024;
const READ_LIMIT = 50;

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) {
    return NextResponse.json({ error: "app not found" }, { status: 404 });
  }
  const entries = topMemoryEntries(app.path, READ_LIMIT);
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) {
    return NextResponse.json({ error: "app not found" }, { status: 404 });
  }
  let body: { entry?: unknown };
  try {
    body = (await req.json()) as { entry?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = body.entry;
  if (typeof entry !== "string") {
    return NextResponse.json(
      { error: "entry must be a string" },
      { status: 400 },
    );
  }
  if (!entry.trim()) {
    return NextResponse.json({ error: "entry is empty" }, { status: 400 });
  }
  if (entry.length > MAX_ENTRY_CHARS) {
    return NextResponse.json(
      { error: `entry exceeds ${MAX_ENTRY_CHARS} chars` },
      { status: 400 },
    );
  }
  const stored = appendMemory(app.path, entry);
  if (!stored) {
    return NextResponse.json(
      { error: "failed to persist memory entry" },
      { status: 500 },
    );
  }
  return NextResponse.json({ stored }, { status: 201 });
}
