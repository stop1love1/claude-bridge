import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta } from "@/lib/meta";
import { resolveRepoCwd } from "@/lib/repos";
import { projectDirFor } from "@/lib/sessions";
import { addUsage, sumUsageFromJsonl, type SessionUsage } from "@/lib/sessionUsage";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/lib/paths";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface PerRunUsage extends SessionUsage {
  sessionId: string;
  role: string;
  repo: string;
}

/**
 * Aggregate token usage for every run of a task.
 *
 *   GET /api/tasks/<id>/usage
 *
 * Walks each run's `~/.claude/projects/<slug>/<sessionId>.jsonl`,
 * sums the assistant `message.usage` blocks, and returns both the
 * per-run breakdown and the task-level total. Missing JSONLs (e.g. a
 * session that was deleted from disk) contribute zeros instead of
 * failing the whole request.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  const md = readBridgeMd();
  const runs: PerRunUsage[] = [];
  let total: SessionUsage = {
    inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    turns: 0,
  };

  for (const r of meta.runs) {
    const cwd = resolveRepoCwd(md, BRIDGE_ROOT, r.repo);
    const usage: SessionUsage = cwd
      ? sumUsageFromJsonl(join(projectDirFor(cwd), `${r.sessionId}.jsonl`))
      : { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0 };
    runs.push({
      sessionId: r.sessionId,
      role: r.role,
      repo: r.repo,
      ...usage,
    });
    total = addUsage(total, usage);
  }

  return NextResponse.json({ taskId: id, total, runs });
}
