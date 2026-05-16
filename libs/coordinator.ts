import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BRIDGE_FOLDER, BRIDGE_LOGIC_DIR, BRIDGE_ROOT, BRIDGE_URL, SESSIONS_DIR, readBridgeMd } from "./paths";
import { appendRun, readMeta, updateRun } from "./meta";
import { sanitizeUserPromptContent } from "./childPrompt";
import { spawnClaude } from "./spawn";
import type { Task } from "./tasks";
import { loadProfiles } from "./profileStore";
import { resolveRepos } from "./repos";
import {
  getOrComputeScope,
  loadDetectInput,
  renderDetectedScope,
} from "./detect";
import { buildTeamHint } from "./teamHints";

// Run-lifecycle wiring (succeed/fail flip + post-exit gate cascade)
// lives in `runLifecycle.ts` so the cycle-breaking lazy-require pattern
// has a focused home, separate from this file's coordinator-spawn
// plumbing. Re-exported here so existing importers (`retrySpawn`,
// `semanticVerifier`, `app/api/tasks/[id]/agents`) keep working
// unchanged across the split.
export { wireRunLifecycle } from "./runLifecycle";
import { wireRunLifecycle } from "./runLifecycle";

/**
 * Build the canonical `## Detected scope` block for the coordinator.
 * Reads the cached scope from `meta.json` (computed at task creation
 * time by `app/api/tasks/route.ts`). On a cache miss (legacy meta /
 * bridge upgrade mid-flight) computes a fresh scope, persists it, and
 * uses that — the coordinator is never starved of context.
 *
 * Replaces the legacy `## Bridge hint` + `## Repo profiles` pair —
 * one block, same shape children see, no drift.
 */
async function buildDetectedScopeBlock(
  sessionsDir: string,
  task: Pick<Task, "id" | "title" | "body" | "app">,
): Promise<string> {
  try {
    const profiles = loadProfiles()?.profiles ?? undefined;
    const scope = await getOrComputeScope(sessionsDir, () =>
      loadDetectInput({
        taskBody: task.body,
        taskTitle: task.title,
        pinnedRepo: task.app ?? null,
      }),
    );
    const scopeBlock = renderDetectedScope(scope, {
      profiles,
      forCoordinator: true,
    });
    // Append the team-hint block when the task matches a known pattern
    // (currently: UX work on an FE-stack repo → coder → ui-tester).
    // Returns null when no pattern matches → coordinator sees only the
    // scope block, same as before this feature shipped.
    const hint = buildTeamHint({
      taskBody: task.body,
      detectedScope: scope,
      profiles,
    });
    return hint ? `${scopeBlock}\n${hint.block}` : scopeBlock;
  } catch (err) {
    console.error("buildDetectedScopeBlock failed (non-fatal)", err);
    return [
      "## Detected scope",
      "",
      "_(detection layer crashed — see bridge logs. Fall back to reading the task body and BRIDGE.md repos table directly.)_",
      "",
    ].join("\n");
  }
}

/**
 * Splice the `## Detected scope` block in before the coordinator
 * template's `## Your job` heading. Falls back to prepending when the
 * marker is missing (template shape changed).
 */
function spliceScopeBlock(rendered: string, block: string): string {
  const marker = "## Your job";
  const idx = rendered.indexOf(marker);
  if (idx === -1) return `${block}\n${rendered}`;
  return `${rendered.slice(0, idx)}${block}\n${rendered.slice(idx)}`;
}

export async function spawnCoordinatorForTask(
  task: Pick<Task, "id" | "title" | "body"> & { app?: string | null },
): Promise<string | null> {
  const sessionsDir = join(SESSIONS_DIR, task.id);

  // meta.json is created by `createTask` in tasksStore. If it's missing
  // here something upstream is broken — log and bail rather than spawn
  // an orphan coordinator that can't register itself.
  if (!readMeta(sessionsDir)) {
    console.error("coordinator spawn skipped: meta.json missing for", task.id);
    return null;
  }

  try {
    // Pre-allocate the coordinator's session UUID so we can render it
    // into the prompt template. The coordinator used to have to discover
    // its own session id by listing the newest .jsonl in its project
    // dir, which races against any other claude session active in the
    // same cwd — wrong uuid → wrong run patched to "done" → original
    // bridge-pre-registered run stuck at "running" forever.
    const sessionId = randomUUID();

    const template = readFileSync(join(BRIDGE_LOGIC_DIR, "coordinator.md"), "utf8");
    // Build a one-shot example of `repo` to use in curl snippets so the
    // template doesn't have to hardcode a project-specific name.
    let exampleRepo = BRIDGE_FOLDER;
    try {
      const md = readBridgeMd();
      const declared = resolveRepos(md, BRIDGE_ROOT)
        .filter((r) => existsSync(r.path))
        .map((r) => r.name);
      if (declared.length > 0) exampleRepo = declared[0];
    } catch {
      /* fall back to bridge folder name */
    }

    // Substitute STRUCTURAL placeholders first (template-controlled
    // values), then splice in the auto-generated scope block, then USER
    // CONTENT last. Ordering matters for two reasons:
    //
    //   1. If we ran user content first, a task body containing the
    //      literal `{{SESSION_ID}}` would be substituted by the next
    //      pass — leaking the real session uuid into a malicious
    //      prompt or corrupting the template.
    //   2. `spliceScopeBlock` searches for the literal `## Your job`
    //      marker; doing the splice BEFORE the user-content pass means
    //      a body containing that heading cannot relocate the
    //      injection site.
    //
    // We also pass user content through `sanitizeUserPromptContent`
    // which fullwidths `{{` / `}}` and degrades any stray `## Your
    // job` heading via a zero-width space, defending in depth even if
    // the ordering above is changed in the future.
    const safeTitle = sanitizeUserPromptContent(task.title);
    const safeBody = sanitizeUserPromptContent(task.body);
    const baseRendered = template
      .replaceAll("{{SESSION_ID}}", sessionId)
      .replaceAll("{{BRIDGE_URL}}", BRIDGE_URL)
      .replaceAll("{{BRIDGE_FOLDER}}", BRIDGE_FOLDER)
      .replaceAll("{{EXAMPLE_REPO}}", exampleRepo)
      .replaceAll("{{TASK_ID}}", task.id);
    // Inject the canonical `## Detected scope` block — coordinator and
    // every spawned child see the same scope, no drift between the two.
    // Replaces the legacy `## Repo profiles` + `## Bridge hint` pair.
    const scopeBlock = await buildDetectedScopeBlock(sessionsDir, {
      id: task.id,
      title: task.title,
      body: task.body,
      app: task.app ?? null,
    });
    const splicedTemplate = spliceScopeBlock(baseRendered, scopeBlock);
    const renderedPrompt = splicedTemplate
      .replaceAll("{{TASK_TITLE}}", safeTitle)
      .replaceAll("{{TASK_BODY}}", safeBody);

    // Append the run BEFORE spawning — H4 orphan-window fix. If
    // `spawnClaude` throws (claude binary missing, fork EAGAIN, etc.)
    // we still have a tracked `failed` row in meta.json instead of a
    // silent gap. `appendRun` is async (per-task lock from cluster B).
    await appendRun(sessionsDir, {
      sessionId,
      role: "coordinator",
      repo: basename(BRIDGE_ROOT),
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    let child;
    try {
      ({ child } = spawnClaude(BRIDGE_ROOT, {
        role: "coordinator",
        taskId: task.id,
        prompt: renderedPrompt,
        sessionId,
        // Coordinator runs unattended — there's no TTY for permission
        // prompts. Without this, the first tool call hangs waiting for
        // confirmation and the process eventually exits. The free-chat
        // permission hook is NOT attached here for the same reason.
        //
        // `disallowedTools: ["Task"]` is the cwd-isolation contract:
        // when the coordinator uses Claude Code's built-in Task / Agent
        // tool, the subagent runs IN-PROCESS sharing the coordinator's
        // cwd (BRIDGE_ROOT). Any work it does lands in `claude-bridge/`
        // instead of the target app folder, AND nothing about it is
        // tracked in `meta.json`. The bridge's only sanctioned dispatch
        // path is `POST /api/tasks/<id>/agents`, which spawns a real
        // child claude with cwd = the app's path. Blocking Task at the
        // CLI level guarantees that a coordinator template change /
        // prompt drift can't quietly route work back to the in-process
        // subagent and break the contract.
        settings: { mode: "bypassPermissions", disallowedTools: ["Task"] },
      }));
    } catch (spawnErr) {
      try {
        await updateRun(sessionsDir, sessionId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      } catch (uErr) {
        console.error("failed to mark coordinator run failed after spawn error", uErr);
      }
      throw spawnErr;
    }

    // Spawn succeeded — promote queued → running with a real
    // startedAt. `wireRunLifecycle` then handles running → done/failed
    // on child exit. Belt-and-suspenders: if the coordinator finishes
    // cleanly (exit 0) but forgot to PATCH itself to "done" via the
    // link API, the lifecycle hook flips the run.
    try {
      await updateRun(sessionsDir, sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    } catch (uErr) {
      console.error("failed to promote coordinator queued → running", uErr);
    }

    wireRunLifecycle(sessionsDir, sessionId, child, `coordinator ${task.id}`);
    return sessionId;
  } catch (err) {
    console.error("coordinator spawn failed for", task.id, err);
    return null;
  }
}
