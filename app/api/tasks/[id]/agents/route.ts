import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendRunIfNotDuplicate, readMeta, updateRun } from "@/lib/meta";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/lib/paths";
import { resolveRepoCwd, resolveRepos } from "@/lib/repos";
import { spawnFreeSession } from "@/lib/spawn";
import { wireRunLifecycle } from "@/lib/coordinator";
import { getApp } from "@/lib/apps";
import { prepareBranch } from "@/lib/gitOps";
import { createWorktreeForRun, removeWorktree } from "@/lib/worktrees";
import { loadProfiles } from "@/lib/profileStore";
import {
  getOrComputeScope,
  loadDetectInput,
  type DetectedScope,
} from "@/lib/detect";
import { buildChildPrompt } from "@/lib/childPrompt";
import { loadHouseRules } from "@/lib/houseRules";
import { topMemoryEntries } from "@/lib/memory";
import { loadPlaybook } from "@/lib/playbooks";
import { loadPinnedFiles } from "@/lib/pinnedFiles";
import { ensureFreshSymbolIndex } from "@/lib/symbolStore";
import { ensureFreshStyleFingerprint } from "@/lib/styleStore";
import { attachReferences } from "@/lib/contextAttach";
import { buildRecentDirection } from "@/lib/recentDirection";
import { isValidTaskId } from "@/lib/tasks";
import { badRequest, isValidAgentRole, isValidSessionId } from "@/lib/validate";
import {
  freeSessionSettingsPath,
  writeSessionSettings,
} from "@/lib/permissionSettings";
import {
  announcePending,
  subscribe,
  type PendingRequest,
} from "@/lib/permissionStore";

export const dynamic = "force-dynamic";
// `waitForSpawnApproval` blocks for up to APPROVAL_TIMEOUT_MS (180s) when
// the caller opted in to user mediation. Next.js' default request
// timeout is plenty on bare-metal Node, but some serverless hosts cap
// shorter. Be explicit and pad past the 180s ceiling so we never get
// the 504 racing with the deny-on-timeout path.
export const maxDuration = 200;

const execFileP = promisify(execFile);

interface AgentBody {
  role: string;
  repo: string;
  prompt: string;
  parentSessionId?: string;
  requireUserApproval?: boolean;
  /**
   * Escape hatch for the (parentSessionId, role, repo) dedup check.
   * Default `false` → if the same coordinator already has an active
   * (queued/running) child with the same role + repo, the spawn is
   * rejected with 409. Set to `true` for the rare case where two
   * agents really should target the same repo with the same role
   * (caller must have a good reason — usually it's a coordinator bug).
   */
  allowDuplicate?: boolean;
  /**
   * Force-disable speculative fan-out for this dispatch even when the
   * app has `dispatch.speculative.enabled = true`. Used by retry
   * spawners (`-vretry`, `-cretry`, …) so a verify-failure retry
   * doesn't itself fan out — that would multiply the retry budget by
   * `n` and clog the agent tree. Default `false`.
   */
  noSpeculative?: boolean;
}

interface SpeculativeDecision {
  enabled: boolean;
  n: number;
  groupId: string | null;
  reason: string;
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * Spawn a child Claude agent for a task. Centralizes what the coordinator
 * used to do via raw `claude -p` Bash calls. The bridge:
 *
 *  1. Validates the request and resolves the target repo.
 *  2. Pre-mints the session UUID (no .jsonl race like the old path).
 *  3. Pre-warms the prompt with `git status / log / ls-files` from the
 *     target repo so the child opens with cheap context.
 *  4. (Optionally) blocks on a "spawn_agent" permission popup the user
 *     answers from the parent coordinator's existing SSE stream.
 *  5. Spawns the child via `spawnFreeSession` (which auto-registers it
 *     in the in-process spawn registry for kill / liveness checks).
 *  6. Appends a `running` run to the task's meta.json with the
 *     parent->child link captured so the agent tree can render it.
 *  7. Wires lifecycle so the run flips to done/failed on exit.
 *
 * Returns 201 `{ sessionId, action: "spawned" }` on success.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  let body: Partial<AgentBody>;
  try {
    body = (await req.json()) as Partial<AgentBody>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const role = typeof body.role === "string" ? body.role.trim() : "";
  const explicitRepo = typeof body.repo === "string" ? body.repo.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const parentSessionId =
    typeof body.parentSessionId === "string" && body.parentSessionId
      ? body.parentSessionId
      : undefined;
  // H1: parentSessionId is written into meta.json and used as the
  // permissionStore key when blocking on user-approval. Same threat
  // shape as every other sessionId — gate it before it lands in either.
  if (parentSessionId !== undefined && !isValidSessionId(parentSessionId)) {
    return badRequest("invalid parentSessionId");
  }
  // Default OFF: spawning is auto-approved unless the caller explicitly
  // sets `requireUserApproval: true`. CLI / programmatic callers without
  // a parent session id implicitly skip it too, since there's nowhere
  // to surface the dialog.
  const requireUserApproval = body.requireUserApproval === true;
  const allowDuplicate = body.allowDuplicate === true;
  const noSpeculative = body.noSpeculative === true;

  if (!role) {
    return NextResponse.json({ error: "role is required" }, { status: 400 });
  }
  // CRIT-5 / M4: gate role to a tight charset before it gets templated
  // into filenames (see prompt route's `${run.role}-${run.repo}.prompt.txt`)
  // and meta.json. We only validate role here; repo is validated below
  // against the BRIDGE.md repo list, which is itself a closed set.
  if (!isValidAgentRole(role)) {
    return badRequest("invalid role");
  }
  if (!prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  // BRIDGE.md is the canonical Repos-table source, but the bridge has
  // to keep working in fresh checkouts where it hasn't been written yet
  // (the apps registry in `bridge.json` is the actual source of truth
  // post-Phase-G). Empty string = "no repos declared via BRIDGE.md",
  // which is the same fallback `resolveRepos` already handles.
  const md = readBridgeMd();
  const profileStore = loadProfiles();
  const profilesMap = profileStore?.profiles;

  // Read the task's pre-detected scope (computed at task creation time
  // by `app/api/tasks/route.ts`). On a cache miss (e.g. a legacy task
  // created before the detect layer existed) we fall back to live
  // detection on the task body, persisting the result so subsequent
  // spawns see the same scope. Coordinator and every child read this
  // same cache — no drift.
  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  let detectedScope: DetectedScope | null = null;
  try {
    detectedScope = await getOrComputeScope(sessionsDir, () =>
      loadDetectInput({
        taskBody: meta.taskBody,
        taskTitle: meta.taskTitle,
        pinnedRepo: meta.taskApp ?? null,
        repos: resolveRepos(md, BRIDGE_ROOT).map((r) => r.name),
      }),
    );
  } catch (err) {
    console.warn("[detect] agents route: scope load failed (non-fatal):", err);
  }

  // When the caller didn't pin a repo, prefer the cached scope's top
  // pick — this is the standardized contract: detection happens once
  // per task, not per spawn. Live re-detection per spawn would race
  // the LLM upgrade and produce non-deterministic dispatch.
  let repo = explicitRepo;
  let autoDetected = false;
  let autoDetectReason: string | null = null;
  let autoDetectScore = 0;
  if (!repo) {
    const declaredRepos = resolveRepos(md, BRIDGE_ROOT).map((r) => r.name);
    const top = detectedScope?.repos.find((r) => declaredRepos.includes(r.name));
    if (!top) {
      return NextResponse.json(
        {
          error: "no repo provided and detection could not infer one",
          reason: detectedScope?.reason ?? "no detected scope available",
        },
        { status: 400 },
      );
    }
    repo = top.name;
    autoDetected = true;
    autoDetectReason = `${detectedScope?.source ?? "heuristic"}: ${top.reason}`;
    autoDetectScore = top.score;
  }

  const repoCwd = resolveRepoCwd(md, BRIDGE_ROOT, repo);
  if (!repoCwd) {
    return NextResponse.json(
      { error: `unknown repo: ${repo}` },
      { status: 400 },
    );
  }

  // Early dedup fast-path: rejects the common "coordinator double-POSTed
  // the same agent in one turn" case BEFORE we allocate a worktree, write
  // a per-session settings file, or build the prompt context. The
  // canonical, race-safe check still runs inside the per-task lock at
  // `appendRunIfNotDuplicate` further down — this is a pure optimization
  // to avoid wasted work for the overwhelmingly common case.
  if (!allowDuplicate) {
    const dup = meta.runs.find(
      (r) =>
        (r.parentSessionId ?? null) === (parentSessionId ?? null) &&
        r.role === role &&
        r.repo === repo &&
        (r.status === "queued" || r.status === "running"),
    );
    if (dup) {
      return NextResponse.json(
        {
          error: "duplicate spawn",
          reason:
            "an active (queued/running) child with the same parentSessionId, role, and repo already exists for this task",
          existingSessionId: dup.sessionId,
          existingStatus: dup.status,
          repo,
          role,
        },
        { status: 409 },
      );
    }
  }

  // Per-app git workflow: if the resolved repo matches a registered
  // app, honor its `git.branchMode` before the child sees the tree.
  // Failures abort the spawn — we don't want a child editing the wrong
  // branch silently.
  // P4/F1 — when worktreeMode is enabled, the worktree owns its
  // branch (createWorktreeForRun runs `git worktree add -b <branch>`).
  // Running prepareBranch in the LIVE tree first would either move HEAD
  // unnecessarily or, worse, claim the same branch the worktree wants
  // to check out (branches can't be checked out in two places at once).
  // Skip prepareBranch in worktree mode — the worktree handles branch
  // policy via `resolveTargetBranch` in `lib/worktrees.ts`.
  const app = getApp(repo);
  const useWorktree = !!(app && app.git.worktreeMode === "enabled");
  if (app && app.git.branchMode !== "current" && !useWorktree) {
    const result = await prepareBranch(repoCwd, app.git, id);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: `git branch setup failed: ${result.message}`,
          detail: result.error ?? null,
          repo,
          branchMode: app.git.branchMode,
        },
        { status: 500 },
      );
    }
  }

  // Decide whether to fan out N speculative siblings. Requires:
  //   - app.dispatch.speculative.enabled === true
  //   - role is in the configured roles set (default ["coder"])
  //   - worktree mode is on (live-tree fan-out would race the shared HEAD)
  //   - caller didn't opt out via noSpeculative or allowDuplicate
  // Falls through to single-spawn (n=1) when any precondition fails.
  const speculative = decideSpeculative({
    app,
    role,
    useWorktree,
    noSpeculative,
    allowDuplicate,
  });

  // Per-sibling outputs the loop accumulates. Used to build the response
  // and to clean up partial state if a mid-loop spawn fails.
  const spawned: Array<{
    sessionId: string;
    repo: string;
    worktreePath: string | null;
    variantIndex: number;
  }> = [];

  for (let variantIndex = 0; variantIndex < speculative.n; variantIndex++) {
  // Pre-mint the child session UUID. Same fix as coordinator: avoids the
  // "newest .jsonl in project dir" race when other claude sessions are
  // active in the same cwd.
  const sessionId = randomUUID();

  // P4/F1 — when worktree mode is enabled, create a private worktree
  // BEFORE spawning so the child's cwd is the isolated copy.
  //
  // SAFETY: when `worktreeMode === "enabled"` we must NOT silently
  // fall back to the live tree on create failure — that would let an
  // agent edit the operator's working copy in spite of the explicit
  // isolation contract. Instead, surface a 500 with the failure detail
  // so the operator notices and can investigate (stale `.worktrees/`
  // leftovers, locked file handles on Windows, etc.). The pruner mops
  // up any partial state on the next API hit.
  let spawnCwd = repoCwd;
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  let worktreeBaseBranch: string | null = null;
  if (useWorktree && app) {
    const handle = await createWorktreeForRun({
      appPath: app.path,
      settings: app.git,
      taskId: id,
      sessionId,
    });
    if (handle) {
      spawnCwd = handle.path;
      worktreePath = handle.path;
      worktreeBranch = handle.branch;
      worktreeBaseBranch = handle.baseBranch;
    } else {
      console.error(
        `[worktree] create failed for ${app.name} task ${id} sid ${sessionId}`,
      );
      return NextResponse.json(
        {
          error: "worktree create failed",
          reason:
            "the app has worktreeMode=enabled but the bridge could not create a private worktree for this run; refusing to fall back to the live tree to preserve the isolation contract",
          repo,
          appPath: app.path,
        },
        { status: 500 },
      );
    }
  }

  // Pre-warm: cheap repo context the child can read without burning a
  // tool call. All commands fail-soft — a fresh / non-git repo simply
  // gets a fallback string. We use `execFile` (no shell) so the same
  // path works on Windows + bash + PowerShell parents.
  const contextBlock = await buildRepoContextBlock(spawnCwd);

  // Wrap the coordinator-authored brief with the standard scaffolding
  // (task header, language directive, profile, context, self-register
  // snippet, report contract). The coordinator now passes ONLY the
  // role-specific instructions in `body.prompt` — the bridge owns the
  // boilerplate so children get a consistent, structured prompt
  // regardless of which coordinator wrote them.
  // P1 — opt-in agentic-coder layers. Each loader returns null when
  // the underlying file / config is absent so existing apps without any
  // of these set behave exactly as before.
  const houseRules = loadHouseRules(app?.path ?? null);
  const memoryEntries = topMemoryEntries(app?.path ?? null);
  const playbookBody = loadPlaybook(role);
  const verifyHint = app?.verify ?? null;

  // P3a — symbol index + style fingerprint + pinned files. All gated
  // on `app !== null` because they need the registered app's path. The
  // `ensureFresh*` calls are lazy: cache hit if recent, else re-scan
  // synchronously (file walks are bounded by FILE_WALK_CAP). Pinned
  // files are read fresh per spawn (small list, cheap).
  const symbolIndex = app
    ? ensureFreshSymbolIndex(app.name, app.path, app.symbolDirs)
    : null;
  const styleFingerprint = app
    ? ensureFreshStyleFingerprint(app.name, app.path)
    : null;
  const pinnedFiles = app ? loadPinnedFiles(app.path, app.pinnedFiles) : [];

  // P3b — auto-attach reference files (B2) heuristically picked from
  // the symbol index by task-body keyword overlap, plus recent-direction
  // git log (B4) for the focus dir we infer from the same heuristic.
  // Both gated on `app !== null` (need cwd + index). Pinned paths are
  // excluded so we don't waste an attach slot duplicating pinned content.
  const attachedReferences = app && symbolIndex
    ? attachReferences({
        appPath: app.path,
        taskBody: meta.taskBody,
        symbolIndex,
        excludePaths: pinnedFiles.map((p) => p.rel),
      })
    : [];
  const recentDirection = app
    ? await buildRecentDirection({
        appCwd: app.path,
        taskBody: meta.taskBody,
        symbolIndex,
      })
    : null;

  // For speculative siblings, inject a tiny variant nudge into the
  // coordinator-supplied brief so the children explore *different*
  // angles instead of all running the same path. The variant header is
  // intentionally short — the agent's playbook + brief still does the
  // heavy lifting; we just bias attention slightly. The bridge picks
  // the first run that passes all post-exit gates as the winner.
  const variantPrompt = speculative.enabled
    ? renderSpeculativeVariantPrefix({
        index: variantIndex,
        total: speculative.n,
        groupId: speculative.groupId ?? "",
      }) + "\n\n" + prompt
    : prompt;

  const prependedPrompt = buildChildPrompt({
    taskId: id,
    taskTitle: meta.taskTitle,
    taskBody: meta.taskBody,
    parentSessionId: parentSessionId ?? "(none — programmatic spawn)",
    childSessionId: sessionId,
    role,
    repo,
    repoCwd: spawnCwd,
    contextBlock,
    coordinatorBody: variantPrompt,
    profile: profilesMap?.[repo],
    houseRules,
    playbookBody,
    verifyHint,
    symbolIndex,
    styleFingerprint,
    pinnedFiles,
    attachedReferences,
    recentDirection,
    memoryEntries,
    detectedScope,
  });

  // User mediation. We only ask if (a) the caller didn't opt out AND
  // (b) we have a parent session id to route the popup back to. Without
  // a parent, there's no SSE stream to fire on, so we'd just hang — fail
  // open in that case (CLI / programmatic invocation).
  // Speculative path: skip the popup. Asking N times for one logical
  // dispatch is awful UX, and the operator already opted in to
  // speculative at app-config time.
  if (requireUserApproval && parentSessionId && !speculative.enabled) {
    const decision = await waitForSpawnApproval({
      parentSessionId,
      role,
      repo,
      sessionId,
      prompt,
    });
    if (decision.status === "deny") {
      return NextResponse.json(
        { error: "user denied spawn", reason: decision.reason ?? null },
        { status: 403 },
      );
    }
  }

  // Per-session settings file with the PreToolUse permission hook
  // attached, so the child's tool calls show up in the same UI stream
  // as a free chat session would. The child still runs in
  // `bypassPermissions` mode so it doesn't deadlock if the bridge UI
  // is down — the hook fails open on timeout.
  // TODO(phase-c): when grandchildren spawn each other via the same
  // endpoint, consider whether to inherit / fan out the hook differently.
  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));

  // Append the run BEFORE spawning so a spawn failure can never produce
  // an alive-but-untracked child. The flow is:
  //   1. record `queued` (with dedup check against active siblings),
  //   2. try spawn,
  //   3a. success → `updateRun({status:"running", startedAt: now})`
  //   3b. failure → `updateRun({status:"failed", endedAt: now})` and bail.
  // wireRunLifecycle will then take over and flip running → done/failed
  // on child exit as before.
  //
  // Dedup: same (parentSessionId, role, repo) where status is queued or
  // running → reject with 409. Coordinators occasionally retry their
  // spawn POST in the same turn (LLM lapses, network hiccup); without
  // this check both calls succeed and the user sees two children doing
  // the same job. `allowDuplicate: true` is the escape hatch.
  const dedupKey = {
    parentSessionId: parentSessionId ?? null,
    role,
    repo,
  };
  // For speculative siblings 1..N-1 we bypass dedup — they intentionally
  // share (parent, role, repo) with their sibling at index 0, and the
  // group is identified by `speculativeGroup`. Sibling 0 still runs the
  // normal dedup so a *different* group (e.g. a stale one from a prior
  // dispatch) still 409s correctly.
  const skipDedup = allowDuplicate || (speculative.enabled && variantIndex > 0);
  const dedupResult = await appendRunIfNotDuplicate(
    sessionsDir,
    {
      sessionId,
      role,
      repo,
      status: "queued",
      startedAt: null,
      endedAt: null,
      parentSessionId: parentSessionId ?? null,
      worktreePath: worktreePath ?? null,
      worktreeBranch: worktreeBranch ?? null,
      worktreeBaseBranch: worktreeBaseBranch ?? null,
      speculativeGroup: speculative.groupId,
    },
    (existing) =>
      !skipDedup &&
      (existing.parentSessionId ?? null) === dedupKey.parentSessionId &&
      existing.role === dedupKey.role &&
      existing.repo === dedupKey.repo &&
      (existing.status === "queued" || existing.status === "running"),
  );
  if (!dedupResult.inserted) {
    // Race: the early fast-path check passed but a sibling POST raced
    // ahead of us and won the lock. Clean up the worktree we just
    // created AND the per-session settings dir we wrote — neither
    // will ever be used because the session never started.
    if (worktreePath && app) {
      try {
        await removeWorktree({ appPath: app.path, worktreePath });
      } catch (cleanupErr) {
        console.warn(
          `[dedup-race] worktree cleanup failed for ${worktreePath}:`,
          cleanupErr,
        );
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { cleanupSessionSettings } = require("@/lib/permissionSettings") as typeof import("@/lib/permissionSettings");
      cleanupSessionSettings(sessionId);
    } catch { /* ignore */ }
    return NextResponse.json(
      {
        error: "duplicate spawn",
        reason:
          "an active (queued/running) child with the same parentSessionId, role, and repo already exists for this task",
        existingSessionId: dedupResult.existing.sessionId,
        existingStatus: dedupResult.existing.status,
        repo,
        role,
      },
      { status: 409 },
    );
  }

  let childHandle;
  try {
    childHandle = spawnFreeSession(
      spawnCwd,
      prependedPrompt,
      { mode: "bypassPermissions" },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await updateRun(sessionsDir, sessionId, {
        status: "failed",
        endedAt: new Date().toISOString(),
      });
    } catch (uErr) {
      console.error("failed to mark queued run failed after spawn error", uErr);
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Spawn succeeded — promote queued → running and stamp startedAt now
  // that we actually have a live child. wireRunLifecycle handles the
  // running → done / failed transition on exit.
  try {
    await updateRun(sessionsDir, sessionId, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
  } catch (uErr) {
    console.error("failed to promote queued → running", uErr);
  }

  wireRunLifecycle(sessionsDir, sessionId, childHandle.child, `agent ${id}/${sessionId}`);

  spawned.push({
    sessionId,
    repo,
    worktreePath: worktreePath ?? null,
    variantIndex,
  });
  } // end speculative for-loop

  // Single-spawn path: preserve the legacy response shape so existing
  // callers (coordinator playbook curl, scripts, tests) keep working.
  if (!speculative.enabled) {
    const only = spawned[0];
    return NextResponse.json(
      autoDetected
        ? {
            sessionId: only.sessionId,
            action: "spawned",
            repo,
            autoDetected: true,
            reason: autoDetectReason,
            score: autoDetectScore,
          }
        : { sessionId: only.sessionId, action: "spawned", repo },
      { status: 201 },
    );
  }

  // Speculative path: aggregate response with the group id + every
  // sibling's sessionId. The first sessionId is the "primary" from
  // the caller's perspective so coordinators that hardcode `.sessionId`
  // still pick something sensible to track.
  return NextResponse.json(
    {
      sessionId: spawned[0]?.sessionId,
      action: "spawned-speculative",
      repo,
      group: speculative.groupId,
      siblings: spawned.map((s) => ({
        sessionId: s.sessionId,
        variantIndex: s.variantIndex,
      })),
      ...(autoDetected
        ? { autoDetected: true, reason: autoDetectReason, score: autoDetectScore }
        : {}),
    },
    { status: 201 },
  );
}

/**
 * Decide whether speculative fan-out applies to this dispatch. Falls
 * back to a single spawn (n=1, enabled=false) on any precondition miss.
 *
 * Live-tree fan-out is refused: prepareBranch + auto-create branch
 * names mutate the shared HEAD, so two parallel siblings would race.
 * Worktree mode is the only safe substrate.
 */
function decideSpeculative(args: {
  app: ReturnType<typeof getApp> | null;
  role: string;
  useWorktree: boolean;
  noSpeculative: boolean;
  allowDuplicate: boolean;
}): SpeculativeDecision {
  const { app, role, useWorktree, noSpeculative, allowDuplicate } = args;
  const off = (reason: string): SpeculativeDecision => ({
    enabled: false,
    n: 1,
    groupId: null,
    reason,
  });
  if (noSpeculative) return off("caller opted out via noSpeculative");
  if (allowDuplicate) return off("allowDuplicate=true bypasses speculative");
  if (!app) return off("no registered app");
  const cfg = app.dispatch?.speculative;
  if (!cfg || !cfg.enabled) return off("app.dispatch.speculative disabled");
  if (!useWorktree) {
    return off(
      "speculative requires worktreeMode=enabled (live-tree fan-out races shared HEAD)",
    );
  }
  const roles = cfg.roles ?? ["coder"];
  if (!roles.includes(role)) {
    return off(`role \`${role}\` not in speculative roles ${JSON.stringify(roles)}`);
  }
  const n = cfg.n ?? 2;
  if (n < 2) return off("speculative n < 2");
  return {
    enabled: true,
    n,
    groupId: randomUUID(),
    reason: `fan-out ${n} for ${role}`,
  };
}

/**
 * Build the small variant-nudge block prepended to each speculative
 * sibling's coordinator brief. Intentionally short — the coordinator's
 * own brief and the role playbook still drive the agent. We just bias
 * each sibling toward a different angle so the bridge gets divergent
 * attempts to pick from instead of N near-identical clones.
 */
function renderSpeculativeVariantPrefix(args: {
  index: number;
  total: number;
  groupId: string;
}): string {
  // Variant angles. We rotate through these by `index % len`. Adding
  // more here is a no-op — only the first `total` are visible per
  // dispatch and each sibling still sees the same full brief.
  const angles: ReadonlyArray<{ label: string; nudge: string }> = [
    {
      label: "Conservative",
      nudge: "Prefer the smallest, most surgical change that satisfies the brief. Touch the fewest files. Reuse existing helpers without refactoring them.",
    },
    {
      label: "Refactor-friendly",
      nudge: "If the brief reveals a pattern that's already off in this codebase, fix it as part of the work — within the scope of the task. Extracting a helper or renaming a misleading symbol is in-scope here.",
    },
    {
      label: "Defensive",
      nudge: "Treat every input boundary as untrusted. Add explicit validation + error paths even when the immediate caller looks safe. Lean toward fewer assumptions about pre-conditions.",
    },
    {
      label: "Idiomatic",
      nudge: "Match this codebase's existing patterns even when there's a textbook 'cleaner' approach. The team's conventions outrank generic best-practices for this task.",
    },
  ];
  const angle = angles[args.index % angles.length];
  return [
    "## Speculative variant",
    "",
    `You are variant **${args.index + 1} of ${args.total}** in speculative dispatch group \`${args.groupId.slice(0, 8)}\`. The bridge spawned ${args.total} parallel attempts at this brief and will pick the first one that passes all post-exit gates as the winner; the others will be killed once a winner emerges.`,
    "",
    `**Your variant angle: ${angle.label}.** ${angle.nudge}`,
    "",
    "Don't try to second-guess the other variants — focus on YOUR angle. Honest divergence beats hedged consensus here.",
  ].join("\n");
}

const GIT_TIMEOUT_MS = 3000;

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Build a small markdown context block from `git status / log / ls-files`.
 * Each command runs with a 3s timeout and fails soft to an empty string,
 * so non-git repos / missing-binary boxes still get a (mostly empty) block
 * rather than 500ing the whole spawn request.
 *
 * We use `execFile` (no shell), which works identically whether the
 * Next.js process was launched from bash or PowerShell.
 *
 * Cached for 5 seconds per cwd: when a coordinator dispatches multiple
 * children at once (multi-repo task), each spawn would otherwise pay
 * for 3 git commands × N children. The cache keeps it to one set per
 * cwd per burst — git activity rarely changes inside a 5s window from
 * the bridge's perspective, and a stale row in the prompt is fine.
 */
const REPO_CONTEXT_TTL_MS = 5_000;
const RG = globalThis as unknown as {
  __bridgeRepoContextCache?: Map<string, { value: string; expires: number }>;
};
const repoContextCache: Map<string, { value: string; expires: number }> =
  RG.__bridgeRepoContextCache ?? new Map();
RG.__bridgeRepoContextCache = repoContextCache;

async function buildRepoContextBlock(cwd: string): Promise<string> {
  const now = Date.now();
  const cached = repoContextCache.get(cwd);
  if (cached && cached.expires > now) return cached.value;

  const [status, log, files] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1"]),
    runGit(cwd, ["log", "-10", "--oneline"]),
    runGit(cwd, ["ls-files"]),
  ]);

  const statusBlock = status || "(clean)";
  const logBlock = log || "(no commits)";
  // `git ls-files | head -40` equivalent — keep the first 40 lines.
  const filesTrimmed = files
    ? files.split(/\r?\n/).slice(0, 40).join("\n")
    : "(no tracked files)";

  const block = [
    "## Repo context (auto-injected by bridge)",
    statusBlock,
    "Recent commits:",
    logBlock,
    "Top files:",
    filesTrimmed,
  ].join("\n");
  repoContextCache.set(cwd, { value: block, expires: now + REPO_CONTEXT_TTL_MS });
  // Bound the cache so a long-running bridge with many spawn cwds
  // doesn't accumulate entries beyond what TTL alone evicts.
  if (repoContextCache.size > 64) {
    const oldest = repoContextCache.keys().next().value;
    if (oldest !== undefined) repoContextCache.delete(oldest);
  }
  return block;
}

interface ApprovalDecision {
  status: "allow" | "deny";
  reason?: string;
}

const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Fire a "spawn_agent" pending request on the parent coordinator's
 * permissionStore stream and block until the user answers (allow / deny)
 * or the 3-minute timeout elapses (which we treat as deny — fail safe).
 *
 * Reuses the existing PendingRequest plumbing the PreToolUse hook UI
 * already listens on, so the bridge UI's permission dialog renders the
 * spawn request alongside any tool call requests.
 */
function waitForSpawnApproval(args: {
  parentSessionId: string;
  role: string;
  repo: string;
  sessionId: string;
  prompt: string;
}): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    const settle = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(decision);
    };

    const unsubscribe = subscribe(
      args.parentSessionId,
      () => {
        // pending broadcasts — not interested here
      },
      (answered: PendingRequest) => {
        if (answered.requestId !== requestId) return;
        settle({
          status: answered.status === "allow" ? "allow" : "deny",
          reason: answered.reason,
        });
      },
    );

    const timer = setTimeout(() => {
      settle({ status: "deny", reason: "approval timeout" });
    }, APPROVAL_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    announcePending({
      sessionId: args.parentSessionId,
      requestId,
      tool: "spawn_agent",
      input: {
        role: args.role,
        repo: args.repo,
        sessionId: args.sessionId,
        parentSessionId: args.parentSessionId,
        promptPreview: args.prompt.slice(0, 600),
      },
      createdAt: new Date().toISOString(),
    });
  });
}
