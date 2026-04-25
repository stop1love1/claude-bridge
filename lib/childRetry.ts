import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendRun, emitRetried, readMeta, type Run } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { spawnFreeSession } from "./spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "./permissionSettings";
import { projectDirFor } from "./sessions";
import { BRIDGE_MD, BRIDGE_ROOT, SESSIONS_DIR } from "./paths";

/**
 * Phase D — auto-retry for failed children.
 *
 * Cap: 1 retry per (parentSessionId, role) pair, scoped per-task. We
 * detect prior retries by scanning meta.json for any run whose `role`
 * ends with `-retry` and shares the same `parentSessionId` + same
 * original role prefix. No persistence beyond meta.json — losing the
 * cap on restart is acceptable; a redundant retry isn't catastrophic.
 */

const RETRY_SUFFIX = "-retry";
const MAX_LAST_ASSISTANT_CHARS = 2000;
const MAX_TOOL_INPUT_SNIPPET = 200;
const MAX_TOOL_USE_ENTRIES = 5;
/**
 * If a run ends in <5s after start AND status=failed, treat it as
 * "almost certainly killed by the user via the kill API" — too short for
 * the agent to have meaningfully attempted the task. Loose heuristic, no
 * persistence.
 */
const KILL_DETECTION_WINDOW_MS = 5000;

interface ToolUseEntry {
  tool: string;
  input: string;
}

interface ScheduleArgs {
  taskId: string;
  failedRun: Run;
}

/**
 * Decide whether this failed run is eligible for auto-retry. Eligibility
 * requires: a parent (it's a child, not the coordinator itself), an
 * unsuffixed role (we don't retry retries), no prior retry sibling
 * already in meta.json. Returns null when ineligible.
 */
function isEligibleForRetry(
  taskId: string,
  failedRun: Run,
): { reason: string } | null {
  if (!failedRun.parentSessionId) {
    return { reason: "no parent session — coordinator-level run, not a child" };
  }
  if (failedRun.role.endsWith(RETRY_SUFFIX)) {
    return { reason: "already a retry — no further retries" };
  }

  const sessionsDir = join(SESSIONS_DIR, taskId);
  const meta = readMeta(sessionsDir);
  if (!meta) return { reason: "meta.json missing" };

  const expectedRetryRole = `${failedRun.role}${RETRY_SUFFIX}`;
  const priorRetry = meta.runs.find(
    (r) =>
      r.parentSessionId === failedRun.parentSessionId &&
      r.role === expectedRetryRole,
  );
  if (priorRetry) {
    return { reason: `retry already attempted (${priorRetry.sessionId})` };
  }

  return null; // eligible
}

interface FailedSessionContext {
  lastAssistantText: string;
  recentToolUses: ToolUseEntry[];
}

/**
 * Read the failed child's `.jsonl` and pull out:
 *  - the LAST `assistant` message's text (capped at 2000 chars)
 *  - the most recent N `tool_use` blocks (tool name + truncated input
 *    snippet)
 *
 * Both default to empty/[] on any failure — the retry prompt then just
 * omits the missing block.
 *
 * We single-pass the file in reverse, since the failure context lives at
 * the tail. The .jsonl can be megabytes; we accept the read cost because
 * the file is bounded by the agent's session length and this only runs
 * on a failed-run lifecycle event.
 */
function readFailedSessionContext(
  failedSessionId: string,
  repoCwd: string,
): FailedSessionContext {
  const empty: FailedSessionContext = {
    lastAssistantText: "",
    recentToolUses: [],
  };
  try {
    const projectDir = projectDirFor(repoCwd);
    const jsonlPath = join(projectDir, `${failedSessionId}.jsonl`);
    if (!existsSync(jsonlPath)) return empty;

    const raw = readFileSync(jsonlPath, "utf8");
    const lines = raw.split(/\r?\n/);

    let lastAssistantText = "";
    const toolUses: ToolUseEntry[] = [];

    // Walk backwards. Stop once we have BOTH the last assistant text and
    // enough tool_use entries.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lastAssistantText && toolUses.length >= MAX_TOOL_USE_ENTRIES) break;
      const line = lines[i];
      if (!line || !line.trim()) continue;
      let obj: { type?: string; message?: { content?: unknown } };
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== "assistant") continue;

      const content = obj.message?.content;
      if (Array.isArray(content)) {
        // Collect tool_use blocks in this assistant message (still walking
        // backwards across messages, but within one message we want the
        // textual order — so iterate forward inside, then prepend to the
        // already-collected tail-first list).
        const localTools: ToolUseEntry[] = [];
        let combinedText = "";
        for (const block of content) {
          if (typeof block === "string") {
            combinedText += block;
            continue;
          }
          if (!block || typeof block !== "object") continue;
          const b = block as {
            type?: string;
            text?: string;
            name?: string;
            input?: unknown;
          };
          if (b.type === "text" && typeof b.text === "string") {
            combinedText += b.text;
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            let snippet = "";
            try {
              snippet = JSON.stringify(b.input ?? {});
            } catch {
              snippet = "(unserializable)";
            }
            if (snippet.length > MAX_TOOL_INPUT_SNIPPET) {
              snippet = snippet.slice(0, MAX_TOOL_INPUT_SNIPPET) + "…";
            }
            localTools.push({ tool: b.name, input: snippet });
          }
        }
        if (!lastAssistantText && combinedText) {
          lastAssistantText = combinedText.slice(0, MAX_LAST_ASSISTANT_CHARS);
        }
        // Reverse-walk semantics: messages later in the file should appear
        // last in the final list. We walk back, so PREPEND (in reverse).
        for (let t = localTools.length - 1; t >= 0; t--) {
          if (toolUses.length >= MAX_TOOL_USE_ENTRIES) break;
          toolUses.unshift(localTools[t]);
        }
      } else if (typeof content === "string") {
        if (!lastAssistantText) {
          lastAssistantText = content.slice(0, MAX_LAST_ASSISTANT_CHARS);
        }
      }
    }

    return { lastAssistantText, recentToolUses: toolUses };
  } catch {
    return empty;
  }
}

/**
 * Detect whether a failed run was almost certainly killed by the user
 * via the kill API. Heuristic: status=failed AND endedAt is within
 * KILL_DETECTION_WINDOW_MS of startedAt — too short to represent a real
 * task attempt. False negatives are acceptable (kill that took >5s
 * just shows up as a normal failure); false positives are rare because
 * non-user-caused exits typically take longer to reach failure state.
 */
function looksKilledByUser(failedRun: Run): boolean {
  if (failedRun.status !== "failed") return false;
  if (!failedRun.startedAt || !failedRun.endedAt) return false;
  const start = new Date(failedRun.startedAt).getTime();
  const end = new Date(failedRun.endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return end - start < KILL_DETECTION_WINDOW_MS;
}

/**
 * Render a markdown block describing what happened on the prior attempt.
 * Prepended to the retry's role-specific brief inside the original prompt
 * so the model sees it before the original instructions, with a clear
 * `## Auto-retry context — what failed last time` header.
 */
function renderRetryContextBlock(args: {
  exitCode: number | null;
  lastAssistantText: string;
  recentToolUses: ToolUseEntry[];
  killedByUser: boolean;
}): string {
  const { exitCode, lastAssistantText, recentToolUses, killedByUser } = args;
  const exitStr = exitCode === null ? "non-zero (no code captured)" : String(exitCode);

  const lines: string[] = [
    "## Auto-retry context — what failed last time",
    "",
    `- Exit code: ${exitStr}`,
  ];
  if (killedByUser) {
    lines.push(
      "- Heuristic: the prior run ended within 5s of starting — almost certainly killed by the user via the bridge UI. Treat the prior attempt as a non-attempt; do NOT assume the task is intrinsically blocked.",
    );
  }
  lines.push("");
  lines.push("### Last assistant message before failure");
  if (lastAssistantText) {
    lines.push("```", lastAssistantText, "```");
  } else {
    lines.push("(no assistant message captured)");
  }
  lines.push("");
  lines.push("### Recent tool calls (most recent last, up to 5)");
  if (recentToolUses.length === 0) {
    lines.push("(no tool calls recorded)");
  } else {
    for (const t of recentToolUses) {
      lines.push(`- \`${t.tool}\` — ${t.input}`);
    }
  }
  lines.push("");
  lines.push(
    "Pay attention to whatever blocked the prior attempt. Mark this attempt clearly in your first message (\"Retry attempt\").",
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Locate the original prompt fed to the failed child. The agents POST
 * route saves rendered prompts to `sessions/<task>/<role>-<repo>.prompt.txt`
 * (per coordinator convention) — but we can't rely on that file being
 * present. Fallback: just leave the original-prompt block empty and let
 * the retry agent rely on the failure context + repo state.
 */
function tryReadOriginalPrompt(taskId: string, failedRun: Run): string {
  try {
    const dir = join(SESSIONS_DIR, taskId);
    if (!existsSync(dir)) return "";
    const candidates = readdirSync(dir).filter(
      (f) => f.endsWith(".prompt.txt") && f.startsWith(`${failedRun.role}-`),
    );
    // newest wins — coordinator may rewrite the same role across attempts
    candidates.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    const pick = candidates[0];
    if (!pick) return "";
    return readFileSync(join(dir, pick), "utf8");
  } catch {
    return "";
  }
}

/**
 * Compose the retry prompt: a structured retry-context block at the TOP
 * (so the model sees what failed before reading the original brief),
 * then the original prompt body. The retry context block is prepended
 * because retry runs go through the same `buildChildPrompt` wrapper at
 * the next spawn — but auto-retry currently spawns directly without the
 * wrapper, so we keep the original-prompt body intact so the model still
 * has the boilerplate (task header, role, report contract, etc.) it
 * received the first time.
 */
function buildRetryPrompt(
  originalPrompt: string,
  retryContextBlock: string,
): string {
  const body = originalPrompt.trim() ||
    "(original prompt unavailable — repo state and the failure context " +
      "below are the only signals you have. Inspect the repo, infer the " +
      "intent, and try to make forward progress.)";

  return [retryContextBlock, "---", "", body].join("\n");
}

/**
 * Spawn the retry. Mirrors the inner spawn logic from
 * `app/api/tasks/[id]/agents/route.ts`, minus the user-approval popup
 * (auto-retry is a follow-up to an already-approved spawn) and minus
 * the repo-context pre-warm (we already have failure context to feed
 * the model).
 *
 * Sibling-not-child: `parentSessionId` is set to the SAME parent the
 * failed run had (the coordinator), not the failed run itself, so the
 * tree visualizer renders both attempts as siblings under the
 * coordinator.
 */
function spawnRetryRun(args: {
  taskId: string;
  failedRun: Run;
  exitCode: number | null;
}): { sessionId: string; run: Run } | null {
  const { taskId, failedRun, exitCode } = args;
  const sessionsDir = join(SESSIONS_DIR, taskId);

  // Resolve the same repo the failed run targeted. If the repo isn't
  // resolvable any more (renamed / deleted between the original spawn
  // and the failure), we can't retry — bail.
  let md: string;
  try { md = readFileSync(BRIDGE_MD, "utf8"); }
  catch { return null; }
  const repoCwd = resolveRepoCwd(md, BRIDGE_ROOT, failedRun.repo);
  if (!repoCwd) return null;

  const sessionContext = readFailedSessionContext(failedRun.sessionId, repoCwd);
  const killedByUser = looksKilledByUser(failedRun);
  const retryContextBlock = renderRetryContextBlock({
    exitCode,
    lastAssistantText: sessionContext.lastAssistantText,
    recentToolUses: sessionContext.recentToolUses,
    killedByUser,
  });
  const originalPrompt = tryReadOriginalPrompt(taskId, failedRun);
  const retryPrompt = buildRetryPrompt(originalPrompt, retryContextBlock);

  const sessionId = randomUUID();
  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));

  let childHandle;
  try {
    childHandle = spawnFreeSession(
      repoCwd,
      retryPrompt,
      { mode: "bypassPermissions" },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    console.error("auto-retry spawn failed for", taskId, failedRun.sessionId, e);
    return null;
  }

  const retryRun: Run = {
    sessionId,
    role: `${failedRun.role}${RETRY_SUFFIX}`,
    repo: failedRun.repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: failedRun.parentSessionId ?? null,
    retryOf: failedRun.sessionId,
  };
  appendRun(sessionsDir, retryRun);
  wireRunLifecycle(
    sessionsDir,
    sessionId,
    childHandle.child,
    `auto-retry ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}

/**
 * Public entry point — called from `wireRunLifecycle` after a child
 * run has been marked failed. Re-checks meta.json (the failed run is
 * already in there with status `failed`), validates eligibility, and
 * spawns a single retry. Always non-throwing: a retry-path bug must
 * not take down the lifecycle wire.
 */
export function maybeScheduleRetry(args: ScheduleArgs & { exitCode: number | null }): void {
  try {
    const { taskId, failedRun, exitCode } = args;
    const ineligible = isEligibleForRetry(taskId, failedRun);
    if (ineligible) {
      // Quiet — most failed runs are ineligible (no parent, already a
      // retry, etc.) and we don't want to spam logs.
      return;
    }
    const result = spawnRetryRun({ taskId, failedRun, exitCode });
    if (!result) return;
    emitRetried(taskId, result.run, failedRun.sessionId);
    console.log(
      `[auto-retry] ${taskId}: spawned ${result.sessionId} (role=${result.run.role}) for failed ${failedRun.sessionId}`,
    );
  } catch (e) {
    console.error("auto-retry scheduling crashed", e);
  }
}
