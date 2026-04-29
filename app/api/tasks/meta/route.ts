import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { reapStaleRunsForDir } from "@/libs/staleRunReaper";

export const dynamic = "force-dynamic";

/**
 * Batched: every task's meta.json in one round-trip. Avoids the N+1
 * pattern of the board polling /api/tasks/:id/meta per task every tick.
 * Returns { [taskId]: Meta } — tasks without metadata are simply absent.
 *
 * Reaps stale `running` runs lazily on each call so the UI never
 * shows a permanently-running task whose process has long since died.
 */
export async function GET() {
  const out: Record<string, unknown> = {};
  if (!existsSync(SESSIONS_DIR)) return NextResponse.json(out);
  for (const id of readdirSync(SESSIONS_DIR)) {
    const meta = await reapStaleRunsForDir(join(SESSIONS_DIR, id));
    if (meta) out[id] = meta;
  }
  return NextResponse.json(out);
}
