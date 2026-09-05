import { NextResponse, type NextRequest } from "next/server";
import { join } from "node:path";
import { readMeta, subscribeMeta, type Run } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { isTerminal } from "@/libs/runStatus";
import { serverError } from "@/libs/errorResponse";
import { ok } from "@/libs/apiResponse";
import { logInfo } from "@/libs/log";

export const dynamic = "force-dynamic";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 55_000;

type Ctx = { params: Promise<{ id: string }> };

interface WaitBody {
  parentSessionId: string;
  sessionIds?: string[];
  timeoutMs?: number;
}

export interface WaitResult {
  settled: Run[];
  pending: Run[];
  timedOut: boolean;
}

function partitionChildren(
  runs: Run[],
  parentSessionId: string,
  only: Set<string> | null,
): { settled: Run[]; pending: Run[] } {
  const settled: Run[] = [];
  const pending: Run[] = [];
  for (const r of runs) {
    if (r.parentSessionId !== parentSessionId) continue;
    if (only && !only.has(r.sessionId)) continue;
    if (isTerminal(r.status)) settled.push(r);
    else pending.push(r);
  }
  return { settled, pending };
}

/**
 * Long-poll until at least one of the currently pending children flips to a
 * terminal status, the timeout elapses, or the client goes away. Any meta
 * change re-reads the file rather than trusting the event payload, so a
 * `writeMeta` from `applyManyRuns` counts the same as a `transition`.
 */
function waitForChildSettle(args: {
  taskId: string;
  dir: string;
  parentSessionId: string;
  only: Set<string> | null;
  pendingIds: Set<string>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;

    const snapshot = () =>
      partitionChildren(readMeta(args.dir)?.runs ?? [], args.parentSessionId, args.only);

    const finish = (timedOut: boolean) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (unsub) {
        try { unsub(); } catch { }
      }
      args.signal.removeEventListener("abort", onAbort);
      resolve({ ...snapshot(), timedOut });
    };

    const onAbort = () => finish(false);

    unsub = subscribeMeta(args.taskId, () => {
      if (finished) return;
      const { settled, pending } = snapshot();
      const stillPending = new Set(pending.map((r) => r.sessionId));
      const anySettled =
        settled.some((r) => args.pendingIds.has(r.sessionId)) ||
        [...args.pendingIds].some((sid) => !stillPending.has(sid));
      if (anySettled) finish(false);
    });

    if (args.signal.aborted) {
      finish(false);
      return;
    }
    args.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(true), args.timeoutMs);
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  let body: Partial<WaitBody>;
  try {
    body = (await req.json()) as Partial<WaitBody>;
  } catch {
    return badRequest("invalid JSON body");
  }
  if (!isValidSessionId(body.parentSessionId)) {
    return badRequest("parentSessionId is required and must be a session UUID");
  }
  let only: Set<string> | null = null;
  if (body.sessionIds !== undefined) {
    if (!Array.isArray(body.sessionIds) || !body.sessionIds.every(isValidSessionId)) {
      return badRequest("sessionIds must be an array of session UUIDs");
    }
    only = new Set(body.sessionIds);
  }
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || body.timeoutMs < 0) {
      return badRequest("timeoutMs must be a non-negative number");
    }
    timeoutMs = Math.min(Math.floor(body.timeoutMs), MAX_WAIT_TIMEOUT_MS);
  }

  try {
    const dir = join(SESSIONS_DIR, id);
    const meta = readMeta(dir);
    if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });

    const first = partitionChildren(meta.runs, body.parentSessionId, only);
    if (first.pending.length === 0) {
      return ok<WaitResult>({ ...first, timedOut: false });
    }

    const result = await waitForChildSettle({
      taskId: id,
      dir,
      parentSessionId: body.parentSessionId,
      only,
      pendingIds: new Set(first.pending.map((r) => r.sessionId)),
      timeoutMs,
      signal: req.signal,
    });
    const outcome = result.timedOut
      ? "timed out"
      : req.signal.aborted
        ? "client aborted"
        : "child settled";
    logInfo("tasks:wait", outcome, {
      taskId: id,
      parent: body.parentSessionId.slice(0, 8),
      settled: result.settled.length,
      pending: result.pending.length,
    });
    return ok<WaitResult>(result);
  } catch (err) {
    return NextResponse.json(serverError(err, "tasks:wait"), { status: 500 });
  }
}
