import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendRun, readMeta } from "@/lib/meta";
import { BRIDGE_MD, BRIDGE_ROOT, SESSIONS_DIR } from "@/lib/paths";
import { resolveRepoCwd, resolveRepos } from "@/lib/repos";
import { spawnFreeSession } from "@/lib/spawn";
import { wireRunLifecycle } from "@/lib/coordinator";
import { suggestRepo } from "@/lib/repoHeuristic";
import { loadProfiles } from "@/lib/profileStore";
import { buildChildPrompt } from "@/lib/childPrompt";
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
 * Spawn a child Claude agent for a task. Centralizes what the
 * coordinator used to do via raw `claude -p` Bash calls — see Phase B
 * in tasks.md. The bridge:
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
 *     parent->child link captured for Phase C visualizations.
 *  7. Wires lifecycle so the run flips to done/failed on exit.
 *
 * Returns 201 `{ sessionId, action: "spawned" }` on success.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

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
  // Default OFF: spawning is auto-approved unless the caller explicitly
  // sets `requireUserApproval: true`. CLI / programmatic callers without
  // a parent session id implicitly skip it too, since there's nowhere
  // to surface the dialog.
  const requireUserApproval = body.requireUserApproval === true;

  if (!role) {
    return NextResponse.json({ error: "role is required" }, { status: 400 });
  }
  if (!prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const md = readFileSync(BRIDGE_MD, "utf8");
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

  // Pre-mint the child session UUID. Same fix as coordinator: avoids the
  // "newest .jsonl in project dir" race when other claude sessions are
  // active in the same cwd.
  const sessionId = randomUUID();

  // Pre-warm: cheap repo context the child can read without burning a
  // tool call. All commands fail-soft — a fresh / non-git repo simply
  // gets a fallback string. We use `execFile` (no shell) so the same
  // path works on Windows + bash + PowerShell parents.
  const contextBlock = await buildRepoContextBlock(repoCwd);

  // Wrap the coordinator-authored brief with the standard scaffolding
  // (task header, language directive, profile, context, self-register
  // snippet, report contract). The coordinator now passes ONLY the
  // role-specific instructions in `body.prompt` — the bridge owns the
  // boilerplate so children get a consistent, structured prompt
  // regardless of which coordinator wrote them.
  const prependedPrompt = buildChildPrompt({
    taskId: id,
    taskTitle: meta.taskTitle,
    taskBody: meta.taskBody,
    parentSessionId: parentSessionId ?? "(none — programmatic spawn)",
    childSessionId: sessionId,
    role,
    repo,
    repoCwd,
    contextBlock,
    coordinatorBody: prompt,
    profile: profilesMap?.[repo],
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

  let childHandle;
  try {
    childHandle = spawnFreeSession(
      repoCwd,
      prependedPrompt,
      { mode: "bypassPermissions" },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  appendRun(sessionsDir, {
    sessionId,
    role,
    repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: parentSessionId ?? null,
  });

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
