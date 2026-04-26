import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/lib/paths";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";
import { readMeta } from "@/lib/meta";
import {
  loadDetectInput,
  refreshScope,
} from "@/lib/detect";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Re-run detection for a task and overwrite the cached scope. Use after
 * editing the task body, or when the operator wants to retry an LLM
 * upgrade that timed out.
 *
 * Honors the configured `detect.source`:
 *   - `auto`      → tries LLM, falls back to heuristic on error
 *   - `llm`       → LLM only; falls back with `confidence: "low"` on err
 *   - `heuristic` → pure local detection
 *
 * Returns `{ scope }` on success.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  try {
    const scope = await refreshScope(sessionsDir, () =>
      loadDetectInput({
        taskBody: meta.taskBody,
        taskTitle: meta.taskTitle,
        pinnedRepo: meta.taskApp ?? null,
      }),
    );
    return NextResponse.json({ scope }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
