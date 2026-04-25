import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { AGENTS_DIR, BRIDGE_FOLDER, BRIDGE_ROOT, BRIDGE_URL, SESSIONS_DIR } from "./paths";
import { appendRun, readMeta, updateRun } from "./meta";
import { spawnClaude } from "./spawn";
import type { Task } from "./tasks";
import { loadProfiles } from "./profileStore";
import type { RepoProfile } from "./repoProfile";
import { suggestRepo } from "./repoHeuristic";
import { resolveRepos } from "./repos";
import { BRIDGE_MD } from "./paths";

/**
 * Wire `error` / `exit` lifecycle on a Claude child so its corresponding
 * meta.json run flips to `done` (clean exit) or `failed` (spawn error /
 * non-zero exit). Used by both the coordinator spawn path and the
 * `/api/tasks/<id>/agents` child spawn path so the same belt-and-
 * suspenders behavior applies everywhere — if the child forgot to PATCH
 * itself via the link API, we still close the run out cleanly.
 *
 * Never overwrites a final state the child already set: only flips when
 * the run is still `running` at the moment of exit.
 *
 * Phase D: after marking the run failed, fire the auto-retry path.
 * `maybeScheduleRetry` decides whether the failure is retryable
 * (it's a child, not coordinator-level; no prior retry exists). The
 * retry helper is lazy-imported to break the import cycle (childRetry
 * uses `wireRunLifecycle` for the retry's own lifecycle).
 */
export function wireRunLifecycle(
  sessionsDir: string,
  sessionId: string,
  child: ChildProcess,
  context?: string,
): void {
  const tag = context ?? sessionsDir;
  const taskId = basename(sessionsDir);

  const tryAutoRetry = (exitCode: number | null) => {
    try {
      const meta = readMeta(sessionsDir);
      const failedRun = meta?.runs.find((r) => r.sessionId === sessionId);
      if (!failedRun || failedRun.status !== "failed") return;
      // Lazy import: childRetry → coordinator (this file) → … breaks
      // the cycle if loaded eagerly at module top.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { maybeScheduleRetry } = require("./childRetry") as typeof import("./childRetry");
      maybeScheduleRetry({ taskId, failedRun, exitCode });
    } catch (e) {
      console.error("auto-retry hook crashed for", tag, e);
    }
  };

  const failRun = (reason: string, exitCode: number | null) => {
    try {
      const meta = readMeta(sessionsDir);
      const run = meta?.runs.find((r) => r.sessionId === sessionId);
      if (run && run.status === "running") {
        updateRun(sessionsDir, sessionId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("failed to mark run failed for", tag, e);
    }
    console.error("run failed for", tag, reason);
    tryAutoRetry(exitCode);
  };

  const succeedRun = () => {
    try {
      const meta = readMeta(sessionsDir);
      const run = meta?.runs.find((r) => r.sessionId === sessionId);
      if (run && run.status === "running") {
        updateRun(sessionsDir, sessionId, {
          status: "done",
          endedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("failed to mark run done for", tag, e);
    }
  };

  child.on("error", (err) => {
    failRun(`spawn error: ${err.message}`, null);
  });
  child.on("exit", (code) => {
    if (code === 0) {
      succeedRun();
    } else if (code !== null) {
      failRun(`exit code ${code}`, code);
    }
  });
}

/**
 * Render a single profile entry as a markdown bullet for the
 * coordinator prompt. Defensive: a profile with no stack/features still
 * produces a usable line.
 */
function renderProfileBullet(p: RepoProfile): string {
  const summary = p.summary?.trim() || `${p.name} — (no summary)`;
  const stack = p.stack.length > 0 ? p.stack.join(", ") : "(unknown)";
  const features = p.features.length > 0 ? p.features.join(", ") : "(none detected)";
  const entrypoints = p.entrypoints.length > 0 ? p.entrypoints.slice(0, 4).join(", ") : "(unknown)";
  return `- **${p.name}** — ${summary} Stack: ${stack}. Features: ${features}. Entrypoints: ${entrypoints}.`;
}

/**
 * Build the "## Bridge hint" block — a heuristic suggestion of which
 * repo the coordinator should target, computed from the task body via
 * `suggestRepo`. Soft signal: the coordinator is the final authority,
 * but a bridge-side first-pass usually saves it 2-3 tool calls.
 *
 * Returns "" when there's no clear winner so the coordinator doesn't
 * mistake "no signal" for "bridge says: skip everything".
 */
function buildBridgeHintBlock(taskBody: string): string {
  try {
    const md = readFileSync(BRIDGE_MD, "utf8");
    const repos = resolveRepos(md, BRIDGE_ROOT)
      .filter((r) => existsSync(r.path))
      .map((r) => r.name);
    if (repos.length === 0) return "";
    const profiles = loadProfiles()?.profiles ?? undefined;
    const s = suggestRepo(taskBody, repos, profiles);
    if (!s.repo) {
      return [
        "## Bridge hint",
        "",
        `Heuristic could not infer a target repo from the task body (${s.reason}).`,
        "Decide based on the **Repo profiles** section above and the task body itself.",
        "",
      ].join("\n");
    }
    return [
      "## Bridge hint",
      "",
      `Heuristic suggests **\`${s.repo}\`** (score: ${s.score}, ${s.reason}).`,
      "Treat this as a starting recommendation — override if the task body genuinely targets a different repo, but explain the override in your final summary so the user can audit.",
      "",
    ].join("\n");
  } catch (err) {
    console.error("buildBridgeHintBlock failed (non-fatal)", err);
    return "";
  }
}

/**
 * Build the "## Repo profiles" markdown section from the cached store
 * and splice it in before the coordinator template's "## Your job"
 * heading. Falls back to a single-line note when the cache is missing
 * — the bridge auto-builds it on the next /api/repos/profiles hit.
 */
function injectRepoProfilesBlock(rendered: string): string {
  let block: string;
  try {
    const store = loadProfiles();
    const profiles = store?.profiles ?? null;
    if (profiles && Object.keys(profiles).length > 0) {
      const lines = Object.values(profiles)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(renderProfileBullet);
      block = [
        "## Repo profiles (auto-built from BRIDGE.md siblings)",
        "",
        ...lines,
        "",
        "Use these to decide which repo to target. Profile data is auto-derived; if it looks wrong, you can override.",
        "",
      ].join("\n");
    } else {
      block = [
        "## Repo profiles",
        "",
        "(repo profiles not yet built — bridge will auto-init on first /api/repos/profiles call)",
        "",
      ].join("\n");
    }
  } catch (err) {
    console.error("injectRepoProfilesBlock failed (non-fatal)", err);
    block = "## Repo profiles\n\n(profile lookup failed — see bridge logs)\n";
  }

  const marker = "## Your job";
  const idx = rendered.indexOf(marker);
  if (idx === -1) {
    // Template shape changed — append at top rather than swallow.
    return `${block}\n${rendered}`;
  }
  return `${rendered.slice(0, idx)}${block}\n${rendered.slice(idx)}`;
}

export function spawnCoordinatorForTask(task: Pick<Task, "id" | "title" | "body">): string | null {
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

    const template = readFileSync(join(AGENTS_DIR, "coordinator.md"), "utf8");
    // Build a one-shot example of `repo` to use in curl snippets so the
    // template doesn't have to hardcode a project-specific name.
    let exampleRepo = BRIDGE_FOLDER;
    try {
      const md = readFileSync(BRIDGE_MD, "utf8");
      const declared = resolveRepos(md, BRIDGE_ROOT)
        .filter((r) => existsSync(r.path))
        .map((r) => r.name);
      if (declared.length > 0) exampleRepo = declared[0];
    } catch {
      /* fall back to bridge folder name */
    }

    // Substitute STRUCTURAL placeholders first (template-controlled
    // values), USER CONTENT last. If we ran user content first, a task
    // body containing the literal `{{SESSION_ID}}` would be substituted
    // by the next pass — leaking the real session uuid into a malicious
    // prompt or corrupting the template. By the time `task.title` /
    // `task.body` are inlined, no further `replaceAll` runs over them.
    const baseRendered = template
      .replaceAll("{{SESSION_ID}}", sessionId)
      .replaceAll("{{BRIDGE_URL}}", BRIDGE_URL)
      .replaceAll("{{BRIDGE_FOLDER}}", BRIDGE_FOLDER)
      .replaceAll("{{EXAMPLE_REPO}}", exampleRepo)
      .replaceAll("{{TASK_ID}}", task.id)
      .replaceAll("{{TASK_TITLE}}", task.title)
      .replaceAll("{{TASK_BODY}}", task.body);
    // Phase G: prepend repo profiles. The block goes before "## Your job"
    // so the coordinator sees the contract surface of every candidate
    // repo before deciding which one to dispatch to. Failure modes are
    // soft: missing cache → single-line note, never blocks spawn.
    const withProfiles = injectRepoProfilesBlock(baseRendered);
    // Bridge hint = heuristic-driven repo suggestion based on the task
    // body itself. Spliced after the profiles block so the coordinator
    // sees both the contract surface AND a concrete starting bet.
    const hintBlock = buildBridgeHintBlock(task.body);
    const renderedPrompt = hintBlock
      ? withProfiles.replace("## Your job", `${hintBlock}## Your job`)
      : withProfiles;

    const { child } = spawnClaude(BRIDGE_ROOT, {
      role: "coordinator",
      taskId: task.id,
      prompt: renderedPrompt,
      sessionId,
      // Coordinator runs unattended — there's no TTY for permission
      // prompts. Without this, the first tool call hangs waiting for
      // confirmation and the process eventually exits. The free-chat
      // permission hook is NOT attached here for the same reason.
      settings: { mode: "bypassPermissions" },
    });
    appendRun(sessionsDir, {
      sessionId,
      role: "coordinator",
      repo: basename(BRIDGE_ROOT),
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
    });

    // Mark the run failed if the spawn itself errors (e.g. ENOENT —
    // claude binary not on PATH) or if the child exits non-zero before
    // the coordinator's self-update could mark it done. Belt-and-
    // suspenders: if the coordinator finishes cleanly (exit 0) but
    // forgot to PATCH itself to "done" via the link API, flip the run.
    // Shared with the child spawn path (`/api/tasks/<id>/agents`).
    wireRunLifecycle(sessionsDir, sessionId, child, `coordinator ${task.id}`);
    return sessionId;
  } catch (err) {
    console.error("coordinator spawn failed for", task.id, err);
    return null;
  }
}
