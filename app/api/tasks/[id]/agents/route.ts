import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendRun, readMeta, updateRun } from "@/lib/meta";
import { BRIDGE_MD, BRIDGE_ROOT, SESSIONS_DIR } from "@/lib/paths";
import { resolveRepoCwd, resolveRepos } from "@/lib/repos";
import { spawnFreeSession } from "@/lib/spawn";
import { wireRunLifecycle } from "@/lib/coordinator";
import { getApp } from "@/lib/apps";
import { prepareBranch } from "@/lib/gitOps";
import { createWorktreeForRun } from "@/lib/worktrees";
import { suggestRepo } from "@/lib/repoHeuristic";
import { loadProfiles } from "@/lib/profileStore";
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
  let md = "";
  try {
    md = readFileSync(BRIDGE_MD, "utf8");
  } catch (err) {
    console.warn("BRIDGE.md unreadable — continuing with empty Repos table", err);
  }
  const profileStore = loadProfiles();
  const profilesMap = profileStore?.profiles;

  // Phase E: when the caller didn't pin a repo, run the keyword heuristic
  // and fall back to that. Heuristic only sees repos declared in
  // BRIDGE.md, so an unknown future bucket entry can't sneak in.
  let repo = explicitRepo;
  let autoDetected = false;
  let autoDetectReason: string | null = null;
  let autoDetectScore = 0;
  if (!repo) {
    const declaredRepos = resolveRepos(md, BRIDGE_ROOT).map((r) => r.name);
    const suggestion = suggestRepo(prompt, declaredRepos, profilesMap);
    if (!suggestion.repo) {
      return NextResponse.json(
        {
          error: "no repo provided and heuristic could not infer one",
          reason: suggestion.reason,
        },
        { status: 400 },
      );
    }
    repo = suggestion.repo;
    autoDetected = true;
    autoDetectReason = suggestion.reason;
    autoDetectScore = suggestion.score;
  }

  const repoCwd = resolveRepoCwd(md, BRIDGE_ROOT, repo);
  if (!repoCwd) {
    return NextResponse.json(
      { error: `unknown repo: ${repo}` },
      { status: 400 },
    );
  }

  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
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

  // Pre-mint the child session UUID. Same fix as coordinator: avoids the
  // "newest .jsonl in project dir" race when other claude sessions are
  // active in the same cwd.
  const sessionId = randomUUID();

  // P4/F1 — when worktree mode is enabled, create a private worktree
  // BEFORE spawning so the child's cwd is the isolated copy. We fall
  // back to the live tree if the worktree create fails — better to ship
  // a degraded run than to refuse the spawn entirely (the operator sees
  // the warning in the logs, and the worktree pruner mops up partials).
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
      console.warn(
        `[worktree] create failed for ${app.name} task ${id} sid ${sessionId} — falling back to live tree`,
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
    coordinatorBody: prompt,
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
  });

  // User mediation. We only ask if (a) the caller didn't opt out AND
  // (b) we have a parent session id to route the popup back to. Without
  // a parent, there's no SSE stream to fire on, so we'd just hang — fail
  // open in that case (CLI / programmatic invocation).
  if (requireUserApproval && parentSessionId) {
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
  //   1. record `queued`,
  //   2. try spawn,
  //   3a. success → `updateRun({status:"running", startedAt: now})`
  //   3b. failure → `updateRun({status:"failed", endedAt: now})` and bail.
  // wireRunLifecycle will then take over and flip running → done/failed
  // on child exit as before.
  await appendRun(sessionsDir, {
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
  });

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

  return NextResponse.json(
    autoDetected
      ? {
          sessionId,
          action: "spawned",
          repo,
          autoDetected: true,
          reason: autoDetectReason,
          score: autoDetectScore,
        }
      : { sessionId, action: "spawned", repo },
    { status: 201 },
  );
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
 */
async function buildRepoContextBlock(cwd: string): Promise<string> {
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

  return [
    "## Repo context (auto-injected by bridge)",
    statusBlock,
    "Recent commits:",
    logBlock,
    "Top files:",
    filesTrimmed,
  ].join("\n");
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
