import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest } from "@/libs/validate";
import { readMeta } from "@/libs/meta";
import {
  loadDetectInput,
  refreshScope,
} from "@/libs/detect";
import { serverError } from "@/libs/errorResponse";

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
    return NextResponse.json(serverError(err, "tasks:detect-refresh"), { status: 500 });
  }
}
