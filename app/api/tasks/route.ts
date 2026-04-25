import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { listTasks, createTask } from "@/lib/tasksStore";
import { spawnCoordinatorForTask } from "@/lib/coordinator";
import { loadApps } from "@/lib/apps";
import {
  profileStoreExists,
  refreshAll,
  type RepoLike,
} from "@/lib/profileStore";

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
  // Fire-and-forget: the spawn writes the run row asynchronously under
  // the meta lock; we don't want to block task creation on it.
  void spawnCoordinatorForTask({ id: task.id, title: task.title, body: task.body });

  return NextResponse.json(task, { status: 201 });
}
