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

export const dynamic = "force-dynamic";

/**
 * Phase G: on the FIRST task creation, kick off a profile-build for
 * every declared repo so the very first coordinator gets an enriched
 * "## Repo profiles" block in its prompt. Subsequent calls — even if
 * stale — are a no-op here; staleness is handled lazily by
 * `ensureFreshOrAuto` on the GET path.
 *
 * Failure is swallowed: never block task creation on profile-build.
 */
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
    console.error("auto-init repo profiles failed (non-fatal)", err);
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
  const { title: givenTitle, body, app } = (await req.json()) as {
    title?: string;
    body?: string;
    app?: string | null;
  };
  const rawBody = (body ?? "").trim();
  const title = givenTitle?.trim() || deriveTitle(rawBody);

  if (!title || (title === "(untitled)" && !rawBody)) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }

  const task = createTask({ title, body: rawBody, app: app ?? null });
  // Phase G: build repo profiles once before the very first coordinator
  // spawn so the prompt gets the enriched "## Repo profiles" block.
  autoInitProfilesOnce();

  // Detect: run the heuristic synchronously and persist BEFORE spawning
  // the coordinator so its prompt reads a populated scope. Then, if the
  // configured mode allows LLM, fire an upgrade in the background that
  // overwrites the cache when complete — child agents spawning later
  // see the upgraded scope. Heuristic-only callers (or environments
  // without claude CLI) get the same behavior as today, just with the
  // standardized contract.
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
          console.warn("[detect] background LLM upgrade failed:", err);
        }
      })();
    }
  } catch (err) {
    console.warn("[detect] sync heuristic write failed (non-fatal):", err);
  }

  // Wrap the coordinator spawn so a `claude` binary missing / fork
  // failure / etc. doesn't make the route return 500 with the task
  // already half-created on disk — that would prompt clients to retry,
  // and each retry would create another duplicate `t_…` directory.
  // Keep the task (createTask already wrote meta.json) and return 201
  // with an `error` field so the UI can surface "task created but
  // coordinator failed to spawn" and offer a manual retry instead of
  // silently double-creating. `spawnCoordinatorForTask` already does
  // an internal try/catch that returns null on failure, but a thrown
  // exception (e.g. profile lookup blowing up unexpectedly) would
  // still escape — this is the belt around its suspenders.
  let spawnError: string | null = null;
  try {
    const sessionId = await spawnCoordinatorForTask({
      id: task.id,
      title: task.title,
      body: task.body,
      app: task.app ?? null,
    });
    if (!sessionId) {
      spawnError = "coordinator spawn returned null (see server logs)";
    }
  } catch (err) {
    spawnError = safeErrorMessage(err, "spawn_failed");
    console.error("spawnCoordinatorForTask threw for", task.id, err);
  }

  return NextResponse.json(
    spawnError ? { ...task, error: spawnError } : task,
    { status: 201 },
  );
}
