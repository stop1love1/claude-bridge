import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listTasks, createTask } from "@/libs/tasksStore";
import { spawnCoordinatorForTask } from "@/libs/coordinator";
import { loadApps } from "@/libs/apps";
import {
  profileStoreExists,
  refreshAll,
  type RepoLike,
} from "@/libs/profileStore";
import {
  getDetectSource,
  heuristicDetector,
  loadDetectInput,
  writeScopeCache,
} from "@/libs/detect";
import { detectWithLLM } from "@/libs/detect/llm";
import { SESSIONS_DIR } from "@/libs/paths";
import { safeErrorMessage } from "@/libs/errorResponse";
import { isValidEffort } from "@/libs/validate";
import { checkRateLimit } from "@/libs/rateLimit";
import { verifyRequestAuth, verifyRequestActor } from "@/libs/auth";
import { getClientIp } from "@/libs/clientIp";
import { readPlanGateConfig } from "@/libs/planGateConfig";
import { setIntake } from "@/libs/meta";
import { logError, logWarn } from "@/libs/log";

export const dynamic = "force-dynamic";

function autoInitProfilesOnce(): void {
  if (profileStoreExists()) return;
  try {
    const repos: RepoLike[] = loadApps().map((a) => ({
      name: a.name,
      path: a.path,
      exists: existsSync(a.path),
    }));
    if (repos.length > 0) refreshAll(repos);
  } catch (err) {
    logError("tasks", "auto-init repo profiles failed (non-fatal)", err);
  }
}

export function GET() {
  return NextResponse.json(listTasks());
}

function deriveTitle(body: string): string {
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return "(untitled)";
  return firstLine.length > 100 ? firstLine.slice(0, 100).trimEnd() + "…" : firstLine;
}

export async function POST(req: NextRequest) {
  const payload = verifyRequestAuth(req);
  const rlKey =
    payload?.did ?? payload?.sub ?? `ip:${getClientIp(req.headers)}`;
  const denied = checkRateLimit("tasks:create", rlKey, 30, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

  const { title: givenTitle, body, app, effort } = (await req.json()) as {
    title?: string;
    body?: string;
    app?: string | null;
    effort?: unknown;
  };
  const rawBody = (body ?? "").trim();
  const title = givenTitle?.trim() || deriveTitle(rawBody);

  if (!title || (title === "(untitled)" && !rawBody)) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }
  if (effort !== undefined && effort !== null && !isValidEffort(effort)) {
    return NextResponse.json({ error: "invalid effort" }, { status: 400 });
  }

  const task = createTask({
    title,
    body: rawBody,
    app: app ?? null,
    effort: isValidEffort(effort) ? effort : null,
  });
  autoInitProfilesOnce();

  try {
    const sessionsDir = join(SESSIONS_DIR, task.id);
    const detectInput = loadDetectInput({
      taskBody: task.body,
      taskTitle: task.title,
      pinnedRepo: task.app ?? null,
    });
    const baseline = await heuristicDetector.detect(detectInput);
    await writeScopeCache(sessionsDir, baseline);
    const mode = getDetectSource();
    if (mode === "auto" || mode === "llm") {
      void (async () => {
        try {
          const upgraded = await detectWithLLM(detectInput);
          if (upgraded) {
            await writeScopeCache(sessionsDir, upgraded);
          }
        } catch (err) {
          logWarn("detect", "background LLM upgrade failed", { error: (err as Error)?.message ?? String(err) });
        }
      })();
    }
  } catch (err) {
    logWarn("detect", "sync heuristic write failed (non-fatal)", { error: (err as Error)?.message ?? String(err) });
  }

  try {
    const cfg = readPlanGateConfig();
    const actor = verifyRequestActor(req);
    const gateApplies = cfg.operatorEnabled || actor?.kind === "guest";
    if (gateApplies) {
      await setIntake(join(SESSIONS_DIR, task.id), {
        status: "planning",
        submittedBy:
          actor?.kind === "guest"
            ? { kind: "guest", label: "guest" }
            : { kind: "operator", label: "operator" },
      });
    }
  } catch (err) {
    logWarn("plan-gate", "task-create gate init failed (non-fatal)", { error: (err as Error)?.message ?? String(err) });
  }

  let spawnError: string | null = null;
  try {
    const sessionId = await spawnCoordinatorForTask({
      id: task.id,
      title: task.title,
      body: task.body,
      app: task.app ?? null,
      effort: task.effort ?? null,
    });
    if (!sessionId) {
      spawnError = "coordinator spawn returned null (see server logs)";
    }
  } catch (err) {
    spawnError = safeErrorMessage(err, "spawn_failed");
    logError("coordinator", "spawnCoordinatorForTask threw", err, { taskId: task.id });
  }

  return NextResponse.json(
    spawnError ? { ...task, error: spawnError } : task,
    { status: 201 },
  );
}
