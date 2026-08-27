import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendRunIfNotDuplicate, readMeta, readIntake, setIntake, updateRun, type Run } from "@/libs/meta";
import { claimRunForResume, type ClaimRunForResumeResult } from "@/libs/resumeGuard";
import { evaluatePlanGate } from "@/libs/planGate";
import { readPlanGateConfig } from "@/libs/planGateConfig";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { ensureSystemPromptFile } from "@/libs/systemPrompt";
import { resolveRepoCwd, resolveRepos } from "@/libs/repos";
import { guestMayTargetRepo } from "@/libs/guestRepoBinding";
import { resumeClaude, spawnFreeSession } from "@/libs/spawn";
import { wireRunLifecycle, spawnCoordinatorForTask } from "@/libs/coordinator";
import { getApp, type AppGitSettings } from "@/libs/apps";
import { verifyRequestActor, type Actor } from "@/libs/auth";
import { prepareBranch } from "@/libs/gitOps";
import { acquireRepoReservation, releaseRepoReservation } from "@/libs/repoReservation";
import { createWorktreeForRun, removeWorktree } from "@/libs/worktrees";
import { loadProfiles } from "@/libs/profileStore";
import {
  getOrComputeScope,
  loadDetectInput,
  type DetectedScope,
} from "@/libs/detect";
import {
  buildChildPrompt,
  buildSystemPromptAppend,
  buildUserMessage,
} from "@/libs/childPrompt";
import { findNearDuplicateRole } from "@/libs/nearDuplicateRole";
import { buildResumePrompt } from "@/libs/resumePrompt";
import { loadHouseRules } from "@/libs/houseRules";
import { topMemoryEntries } from "@/libs/memory";
import { loadPlaybook } from "@/libs/playbooks";
import { loadSharedPlan } from "@/libs/sharedPlan";
import { loadPeerNotes } from "@/libs/peerNotes";
import { loadPinnedFiles } from "@/libs/pinnedFiles";
import { ensureFreshSymbolIndex } from "@/libs/symbolStore";
import { ensureFreshStyleFingerprint } from "@/libs/styleStore";
import { attachReferences } from "@/libs/contextAttach";
import { buildRecentDirection } from "@/libs/recentDirection";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidAgentRole, isValidEffort, isValidSessionId, type EffortLevel } from "@/libs/validate";
import { safeErrorMessage, serverError } from "@/libs/errorResponse";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";
import {
  freeSessionSettingsPath,
  writeSessionSettings,
} from "@/libs/permissionSettings";
import {
  announcePending,
  subscribe,
  type PendingRequest,
} from "@/libs/permissionStore";

export const dynamic = "force-dynamic";
export const maxDuration = 200;

const execFileP = promisify(execFile);

interface AgentBody {
  role: string;
  repo: string;
  prompt: string;
  parentSessionId?: string;
  requireUserApproval?: boolean;
  allowDuplicate?: boolean;
  noSpeculative?: boolean;
  mode?: "spawn" | "resume";
  effort?: EffortLevel;
  priorSessionId?: string;
}

interface SpeculativeDecision {
  enabled: boolean;
  n: number;
  groupId: string | null;
  reason: string;
}

type Ctx = { params: Promise<{ id: string }> };

const PROMPT_CACHE_ENABLED = process.env.BRIDGE_PROMPT_CACHE !== "0";


function effectiveGitForActor(
  appGit: AppGitSettings,
  actor: Actor | null,
  taskId: string,
): AppGitSettings {
  if (actor?.kind !== "guest") return appGit;
  const g = actor.share.git;
  const isolate = g.branchMode === "auto-create" && appGit.worktreeMode !== "enabled";
  const guestSeg = actor.did.replace(/[^a-z0-9]/gi, "").slice(-6) || "guest";
  return {
    ...appGit,
    branchMode: isolate ? "fixed" : g.branchMode,
    fixedBranch: isolate
      ? `claude/${taskId}-g${guestSeg}`
      : g.branchMode === "fixed"
        ? (g.branchName ?? "")
        : appGit.fixedBranch,
    autoCommit: g.autoCommit,
    autoPush: g.autoPush && actor.grants.push,
    integrationMode: "none",
  };
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");

  const denied = checkRateLimit("tasks:agents:ip", getClientIp(req.headers), 60, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

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
  if (parentSessionId !== undefined && !isValidSessionId(parentSessionId)) {
    return badRequest("invalid parentSessionId");
  }
  const requireUserApproval = body.requireUserApproval === true;
  const allowDuplicate = body.allowDuplicate === true;
  const noSpeculative = body.noSpeculative === true;
  let mode: "spawn" | "resume" = "spawn";
  if (body.mode !== undefined) {
    if (body.mode !== "spawn" && body.mode !== "resume") {
      return badRequest("invalid mode (must be 'spawn' or 'resume')");
    }
    mode = body.mode;
  }
  const priorSessionId =
    typeof body.priorSessionId === "string" && body.priorSessionId
      ? body.priorSessionId
      : undefined;
  if (priorSessionId !== undefined) {
    if (!isValidSessionId(priorSessionId)) {
      return badRequest("invalid priorSessionId");
    }
    if (mode !== "resume") {
      return badRequest("priorSessionId is only valid with mode: 'resume'");
    }
  }
  if (body.effort !== undefined && !isValidEffort(body.effort)) {
    return badRequest("invalid effort");
  }
  const requestedEffort: EffortLevel | undefined = isValidEffort(body.effort)
    ? body.effort
    : undefined;

  if (!role) {
    return NextResponse.json({ error: "role is required" }, { status: 400 });
  }
  if (!isValidAgentRole(role)) {
    return badRequest("invalid role");
  }
  if (!prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const md = readBridgeMd();
  const profileStore = loadProfiles();
  const profilesMap = profileStore?.profiles;

  const sessionsDir = join(SESSIONS_DIR, id);
  const meta = readMeta(sessionsDir);
  if (!meta) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const actor = verifyRequestActor(req);
  const effectiveEffort: EffortLevel | undefined =
    requestedEffort ?? meta.taskEffort ?? undefined;
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

  if (
    !guestMayTargetRepo({
      actorKind: actor?.kind === "guest" ? "guest" : "operator",
      repo,
      taskApp: meta.taskApp ?? null,
    })
  ) {
    return NextResponse.json(
      { error: "guest may only target this task's app" },
      { status: 403 },
    );
  }

  const repoCwd = resolveRepoCwd(md, BRIDGE_ROOT, repo);
  if (!repoCwd) {
    return NextResponse.json(
      { error: `unknown repo: ${repo}` },
      { status: 400 },
    );
  }

  {
    const cfg = readPlanGateConfig();
    const gateApplies = cfg.operatorEnabled || actor?.kind === "guest";
    const intake = readIntake(sessionsDir);
    const decision = evaluatePlanGate({
      role,
      intakeStatus: intake?.status ?? "none",
      gateApplies,
    });
    if (!decision.allowed) {
      if (decision.kickPlanning) {
        await setIntake(sessionsDir, {
          status: "planning",
          submittedBy:
            actor?.kind === "guest"
              ? { kind: "guest", label: "guest" }
              : { kind: "operator", label: "operator" },
        });
        const hasActiveCoordinator = meta.runs.some(
          (r) => r.role === "coordinator" && (r.status === "running" || r.status === "queued"),
        );
        if (!hasActiveCoordinator) {
          void spawnCoordinatorForTask({
            id: meta.taskId,
            title: meta.taskTitle,
            body: meta.taskBody,
            app: meta.taskApp ?? null,
            effort: meta.taskEffort ?? null,
          });
        }
      }
      return NextResponse.json(
        {
          error: "plan-gate",
          reason: decision.reason,
          intakeStatus: intake?.status ?? "none",
          kickedPlanning: decision.kickPlanning,
        },
        { status: 423 },
      );
    }
  }

  if (mode === "resume") {
    return handleResume({
      sessionsDir,
      taskId: id,
      taskTitle: meta.taskTitle,
      taskBody: meta.taskBody,
      role,
      repo,
      repoCwd,
      prompt,
      parentSessionId: parentSessionId ?? null,
      priorSessionId: priorSessionId ?? null,
      runs: meta.runs,
      effort: effectiveEffort,
    });
  }

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

  const app = getApp(repo);
  const effGit = app ? effectiveGitForActor(app.git, actor, id) : null;
  const useWorktree = !!(app && effGit && effGit.worktreeMode === "enabled");

  let reservedSessionId: string | null = null;
  if (app && !useWorktree) {
    reservedSessionId = randomUUID();
    const reservation = acquireRepoReservation(app.name, reservedSessionId);
    if (!reservation.ok) {
      return NextResponse.json(
        {
          error: "repo reserved",
          reason:
            `app "${app.name}" has worktreeMode disabled, so only one run may touch its shared working tree at a time; ` +
            `session ${reservation.heldBy} currently holds it — wait for it to finish, kill it, or enable worktreeMode to allow concurrent runs`,
          repo: app.name,
          heldBy: reservation.heldBy ?? null,
        },
        { status: 409 },
      );
    }
  }
  const releaseReservation = () => {
    if (app && reservedSessionId) releaseRepoReservation(app.name, reservedSessionId);
  };

  if (app && effGit && effGit.branchMode !== "current" && !useWorktree) {
    const result = await prepareBranch(repoCwd, effGit, id);
    if (!result.ok) {
      releaseReservation();
      return NextResponse.json(
        {
          error: `git branch setup failed: ${result.message}`,
          detail: result.error ?? null,
          repo,
          branchMode: effGit.branchMode,
        },
        { status: 500 },
      );
    }
  }

  const nearDuplicate = !allowDuplicate
    ? findNearDuplicateRole({
        runs: meta.runs,
        parentSessionId: parentSessionId ?? null,
        repo,
        role,
      })
    : null;

  const speculative = decideSpeculative({
    app,
    role,
    useWorktree,
    noSpeculative,
    allowDuplicate,
  });

  const spawned: Array<{
    sessionId: string;
    repo: string;
    worktreePath: string | null;
    variantIndex: number;
  }> = [];

  for (let variantIndex = 0; variantIndex < speculative.n; variantIndex++) {
  const sessionId = reservedSessionId ?? randomUUID();

  let spawnCwd = repoCwd;
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  let worktreeBaseBranch: string | null = null;
  if (useWorktree && app && effGit) {
    const handle = await createWorktreeForRun({
      appPath: app.path,
      settings: effGit,
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

  const contextBlock = await buildRepoContextBlock(spawnCwd);

  const houseRules = loadHouseRules(app?.path ?? null);
  const memoryEntries = topMemoryEntries(app?.path ?? null);
  const playbookBody = loadPlaybook(role);
  const verifyHint = app?.verify ?? null;
  const sharedPlan = loadSharedPlan(id);
  const peerNotes = loadPeerNotes(id);

  const symbolIndex = app
    ? ensureFreshSymbolIndex(app.name, app.path, app.symbolDirs)
    : null;
  const styleFingerprint = app
    ? ensureFreshStyleFingerprint(app.name, app.path)
    : null;
  const pinnedFiles = app ? loadPinnedFiles(app.path, app.pinnedFiles) : [];

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

  const variantPrompt = speculative.enabled
    ? renderSpeculativeVariantPrefix({
        index: variantIndex,
        total: speculative.n,
        groupId: speculative.groupId ?? "",
        angles: app?.dispatch?.speculative?.angles,
      }) + "\n\n" + prompt
    : prompt;

  const childPromptOpts = {
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
    sharedPlan,
    peerNotes,
  };

  let prependedPrompt: string;
  let systemPromptFile: string | undefined;
  if (PROMPT_CACHE_ENABLED) {
    const sysContent = buildSystemPromptAppend(childPromptOpts);
    systemPromptFile = ensureSystemPromptFile(sysContent) ?? undefined;
    prependedPrompt = buildUserMessage(childPromptOpts);
  } else {
    prependedPrompt = buildChildPrompt(childPromptOpts);
  }

  if (requireUserApproval && parentSessionId && !speculative.enabled) {
    const decision = await waitForSpawnApproval({
      parentSessionId,
      role,
      repo,
      sessionId,
      prompt,
    });
    if (decision.status === "deny") {
      releaseReservation();
      return NextResponse.json(
        { error: "user denied spawn", reason: decision.reason ?? null },
        { status: 403 },
      );
    }
  }

  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));

  const dedupKey = {
    parentSessionId: parentSessionId ?? null,
    role,
    repo,
  };
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
      const { cleanupSessionSettings } = require("@/libs/permissionSettings") as typeof import("@/libs/permissionSettings");
      cleanupSessionSettings(sessionId);
    } catch { }
    releaseReservation();
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
      { mode: "bypassPermissions", effort: effectiveEffort },
      settingsPath,
      sessionId,
      systemPromptFile,
    );
  } catch (e) {
    try {
      await updateRun(sessionsDir, sessionId, {
        status: "failed",
        endedAt: new Date().toISOString(),
      });
    } catch (uErr) {
      console.error("failed to mark queued run failed after spawn error", uErr);
    }
    releaseReservation();
    return NextResponse.json(serverError(e, "tasks:agent-spawn"), { status: 500 });
  }

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
  }

  const warningPayload = nearDuplicate
    ? {
        warning: {
          kind: "near-duplicate-role",
          existingSessionId: nearDuplicate.existing.sessionId,
          existingRole: nearDuplicate.existing.role,
          suggestedResume: {
            mode: "resume",
            role: nearDuplicate.existing.role,
            repo,
            priorSessionId: nearDuplicate.existing.sessionId,
          },
          message: nearDuplicate.reason,
        },
      }
    : {};

  if (warningPayload.warning) {
    console.warn(
      `[agents] near-duplicate role for task ${id}: spawned \`${role}\` while \`${nearDuplicate?.existing.role}\` (sid ${nearDuplicate?.existing.sessionId.slice(0, 8)}) was already a finished sibling on the same parent+repo`,
    );
  }

  if (!speculative.enabled) {
    const only = spawned[0];
    return NextResponse.json(
      {
        sessionId: only.sessionId,
        action: "spawned",
        repo,
        ...(autoDetected
          ? { autoDetected: true, reason: autoDetectReason, score: autoDetectScore }
          : {}),
        ...warningPayload,
      },
      { status: 201 },
    );
  }

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
      ...warningPayload,
    },
    { status: 201 },
  );
}

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

const DEFAULT_SPECULATIVE_ANGLES: ReadonlyArray<{ label: string; nudge: string }> = [
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

export function renderSpeculativeVariantPrefix(args: {
  index: number;
  total: number;
  groupId: string;
  angles?: ReadonlyArray<{ label: string; nudge: string }>;
}): string {
  const angles =
    args.angles && args.angles.length > 0
      ? args.angles
      : DEFAULT_SPECULATIVE_ANGLES;
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

const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

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

async function handleResume(args: {
  sessionsDir: string;
  taskId: string;
  taskTitle: string;
  taskBody: string;
  role: string;
  repo: string;
  repoCwd: string;
  prompt: string;
  parentSessionId: string | null;
  priorSessionId: string | null;
  runs: Run[];
  effort?: EffortLevel;
}): Promise<NextResponse> {
  const {
    sessionsDir,
    taskId,
    role,
    repo,
    repoCwd,
    prompt,
    parentSessionId,
    priorSessionId,
    runs,
    effort,
  } = args;

  let prior: Run;
  if (priorSessionId) {
    const found = runs.find((r) => r.sessionId === priorSessionId);
    if (!found) {
      return NextResponse.json(
        {
          error: "priorSessionId not found in this task",
          reason:
            "no run with that sessionId exists in this task's meta.json; check that the id is correct and that you're targeting the right task",
          priorSessionId,
        },
        { status: 400 },
      );
    }
    if (found.repo !== repo) {
      return NextResponse.json(
        {
          error: "priorSessionId repo mismatch",
          reason: `the run lives in repo \`${found.repo}\` but the request specified \`${repo}\`; resume must target the same repo`,
          priorSessionId,
          actualRepo: found.repo,
        },
        { status: 400 },
      );
    }
    if (found.status === "queued" || found.status === "running") {
      return NextResponse.json(
        {
          error: "cannot resume while target is running",
          reason:
            "the picked sessionId is still queued/running; wait for it to finish (or kill it) before resuming",
          liveSessionId: found.sessionId,
          liveStatus: found.status,
        },
        { status: 409 },
      );
    }
    if (found.speculativeOutcome === "lost") {
      return NextResponse.json(
        {
          error: "prior run is a speculative loser",
          reason:
            "this child was killed during speculative winner selection; its worktree was destroyed and its session cannot be safely resumed. Spawn fresh (omit `mode`) instead.",
          priorSessionId: found.sessionId,
        },
        { status: 410 },
      );
    }
    prior = found;
  } else {
    const matchTriple = (r: Run) =>
      (r.parentSessionId ?? null) === parentSessionId &&
      r.role === role &&
      r.repo === repo;

    const liveSibling = runs.find(
      (r) => matchTriple(r) && (r.status === "queued" || r.status === "running"),
    );
    if (liveSibling) {
      return NextResponse.json(
        {
          error: "cannot resume while a sibling is running",
          reason:
            "a queued/running child with the same parentSessionId, role, and repo is already in flight; wait for it to finish (or kill it) before resuming",
          liveSessionId: liveSibling.sessionId,
          liveStatus: liveSibling.status,
        },
        { status: 409 },
      );
    }

    const completed = runs.filter(
      (r) => matchTriple(r) && (r.status === "done" || r.status === "failed" || r.status === "cancelled"),
    );
    if (completed.length === 0) {
      return NextResponse.json(
        {
          error: "no prior run to resume",
          reason:
            "resume requires a completed (done/failed/cancelled) prior child for the same parentSessionId, role, and repo; none was found in this task. Pass `priorSessionId` to resume a specific session under a different role label.",
          role,
          repo,
          parentSessionId,
        },
        { status: 400 },
      );
    }
    const picked = [...completed].sort((a, b) => {
      const ra = a.status === "done" ? 0 : 1;
      const rb = b.status === "done" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b.endedAt ?? "").localeCompare(a.endedAt ?? "");
    })[0];

    if (picked.speculativeOutcome === "lost") {
      return NextResponse.json(
        {
          error: "prior run is a speculative loser",
          reason:
            "this child was killed during speculative winner selection; its worktree was destroyed and its session cannot be safely resumed. Spawn fresh (omit `mode`) instead.",
          priorSessionId: picked.sessionId,
        },
        { status: 410 },
      );
    }
    prior = picked;
  }

  let spawnCwd = repoCwd;
  if (prior.worktreePath && existsSync(prior.worktreePath)) {
    spawnCwd = prior.worktreePath;
  }

  const priorRoleChanged = prior.role !== role;
  let claim: ClaimRunForResumeResult;
  try {
    claim = await claimRunForResume(
      sessionsDir,
      prior.sessionId,
      priorRoleChanged ? { role } : {},
    );
  } catch (e) {
    console.error("failed to flip resume run back to running", e);
    return NextResponse.json(
      { error: "meta update failed", reason: safeErrorMessage(e) },
      { status: 500 },
    );
  }

  if (!claim.ok) {
    return NextResponse.json(
      {
        error: "resume claim lost the race",
        reason:
          "another request already claimed this session for resume, or its status changed, between the liveness check and the atomic claim; check the run's current status before retrying",
        sessionId: prior.sessionId,
        currentStatus: claim.run?.status ?? null,
      },
      { status: 409 },
    );
  }

  const settingsPath = writeSessionSettings(freeSessionSettingsPath(prior.sessionId));

  const resumePrompt = buildResumePrompt({
    taskId,
    role,
    repo,
    parentSessionId,
    coordinatorBody: prompt,
  });

  let child;
  try {
    child = resumeClaude(
      spawnCwd,
      prior.sessionId,
      resumePrompt,
      { mode: "bypassPermissions", effort },
      settingsPath,
    );
  } catch (e) {
    try {
      await updateRun(sessionsDir, prior.sessionId, {
        status: prior.status,
        endedAt: prior.endedAt,
        ...(priorRoleChanged ? { role: prior.role } : {}),
      });
    } catch (uErr) {
      console.error("failed to roll resume run back after spawn error", uErr);
    }
    return NextResponse.json(serverError(e, "tasks:agent-resume"), { status: 500 });
  }

  wireRunLifecycle(
    sessionsDir,
    prior.sessionId,
    child,
    `agent-resume ${taskId}/${prior.sessionId}`,
  );

  return NextResponse.json(
    {
      sessionId: prior.sessionId,
      action: "resumed",
      repo,
      role,
      priorRole: priorRoleChanged ? prior.role : undefined,
      priorStatus: prior.status,
      priorEndedAt: prior.endedAt,
      cwd: spawnCwd,
    },
    { status: 201 },
  );
}
