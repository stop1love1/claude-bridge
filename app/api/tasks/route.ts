import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { listTasks, createTask } from "@/lib/tasksStore";
import { spawnCoordinatorForTask } from "@/lib/coordinator";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { resolveRepos } from "@/lib/repos";
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
    const md = readFileSync(BRIDGE_MD, "utf8");
    const declared = resolveRepos(md, BRIDGE_ROOT);
    const repos: RepoLike[] = declared.map((r) => ({
      name: r.name,
      path: r.path,
      exists: existsSync(r.path),
    }));
    refreshAll(repos);
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
  const { title: givenTitle, body } = (await req.json()) as { title?: string; body?: string };
  const rawBody = (body ?? "").trim();
  const title = givenTitle?.trim() || deriveTitle(rawBody);

  if (!title || (title === "(untitled)" && !rawBody)) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }

  const task = createTask({ title, body: rawBody });
  // Phase G: build repo profiles once before the very first coordinator
  // spawn so the prompt gets the enriched "## Repo profiles" block.
  autoInitProfilesOnce();
  spawnCoordinatorForTask({ id: task.id, title: task.title, body: task.body });

  return NextResponse.json(task, { status: 201 });
}
