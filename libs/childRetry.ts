import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { emitRetried, readMeta, type Run } from "./meta";
import { resolveRepoCwd } from "./repos";
import { projectDirFor } from "./sessions";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { getApp } from "./apps";
import { spawnRetry } from "./retrySpawn";
import { checkEligibility } from "./retryLadder";

/**
 * Phase D — auto-retry for failed children.
 *
 * Cap: per-app `app.retry.crash` (default 1) attempts per (parent, role)
 * pair, scoped per-task. The ladder helpers in `retryLadder.ts` count
 * prior siblings and pick the strategy for attempt N.
 */

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

export interface ToolUseEntry {
  tool: string;
  input: string;
}

interface ScheduleArgs {
  taskId: string;
  failedRun: Run;
}

/**
 * Decide whether this failed run is eligible for crash auto-retry.
 * Returns the next-attempt number when eligible, or `null` when not.
 *
 * Delegates to `retryLadder.checkEligibility(gate="crash")`, so the
 * per-app `retry.crash` budget governs attempt count.
 */
function isEligibleForRetry(
  taskId: string,
  failedRun: Run,
): { nextAttempt: number } | { reason: string } {
  const sessionsDir = join(SESSIONS_DIR, taskId);
  const meta = readMeta(sessionsDir);
  if (!meta) return { reason: "meta.json missing" };
  const app = getApp(failedRun.repo);
  const elig = checkEligibility({
    finishedRun: failedRun,
    meta,
    gate: "crash",
    retry: app?.retry,
  });
  if (!elig.eligible) {
    return { reason: elig.reason ?? "ineligible" };
  }
  return { nextAttempt: elig.nextAttempt };
}

export interface FailedSessionContext {
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
 * We tail-stream the file backwards in 64 KB chunks because failure
 * context lives at the very end and a session jsonl can grow to many
 * MB after a long agent run. Reading the whole file into RAM (the
 * previous behavior) burnt 100+ MB for the longest sessions and
 * blocked the lifecycle hook for hundreds of ms; the streaming
 * version reads on average ~1 page and exits as soon as we have
 * both the last assistant text and enough tool_use blocks. We cap
 * the total bytes pulled at 1 MB so a pathological file can't hang
 * the lifecycle.
 */
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024;

export function readFailedSessionContext(
  failedSessionId: string,
  repoCwd: string,
): FailedSessionContext {
  const empty: FailedSessionContext = {
    lastAssistantText: "",
    recentToolUses: [],
  };
  const projectDir = projectDirFor(repoCwd);
  const jsonlPath = join(projectDir, `${failedSessionId}.jsonl`);
  if (!existsSync(jsonlPath)) return empty;

  let lastAssistantText = "";
  const toolUses: ToolUseEntry[] = [];

  /** Apply the parse logic to one fully-buffered jsonl line. */
  const consumeLine = (line: string): "done" | "continue" => {
    if (!line || !line.trim()) return "continue";
    let obj: { type?: string; message?: { content?: unknown } };
    try { obj = JSON.parse(line) as typeof obj; } catch { return "continue"; }
    if (obj.type !== "assistant") return "continue";

    const content = obj.message?.content;
    if (Array.isArray(content)) {
      // Collect tool_use blocks in this assistant message in document
      // order, then merge into the tail-first global list.
      const localTools: ToolUseEntry[] = [];
      let combinedText = "";
      for (const block of content) {
        if (typeof block === "string") { combinedText += block; continue; }
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string; name?: string; input?: unknown };
        if (b.type === "text" && typeof b.text === "string") {
          combinedText += b.text;
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          let snippet = "";
          try { snippet = JSON.stringify(b.input ?? {}); } catch { snippet = "(unserializable)"; }
          if (snippet.length > MAX_TOOL_INPUT_SNIPPET) {
            snippet = snippet.slice(0, MAX_TOOL_INPUT_SNIPPET) + "…";
          }
          localTools.push({ tool: b.name, input: snippet });
        }
      }
      if (!lastAssistantText && combinedText) {
        lastAssistantText = combinedText.slice(0, MAX_LAST_ASSISTANT_CHARS);
      }
      // We walk the FILE backwards, so messages we encounter LATER
      // (= earlier in the file) need to appear earlier in the
      // tool-use list. PREPEND in reverse to preserve in-message
      // ordering.
      for (let t = localTools.length - 1; t >= 0; t--) {
        if (toolUses.length >= MAX_TOOL_USE_ENTRIES) break;
        toolUses.unshift(localTools[t]);
      }
    } else if (typeof content === "string") {
      if (!lastAssistantText) {
        lastAssistantText = content.slice(0, MAX_LAST_ASSISTANT_CHARS);
      }
    }
    return (lastAssistantText && toolUses.length >= MAX_TOOL_USE_ENTRIES)
      ? "done"
      : "continue";
  };

  let fd = -1;
  try {
    fd = openSync(jsonlPath, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return empty;

    let pos = size;
    let bytesRead = 0;
    /** Partial line whose head still lives in the unread (earlier) bytes. */
    let pending = "";
    let earlyExit = false;

    while (pos > 0 && bytesRead < TAIL_MAX_BYTES && !earlyExit) {
      const readLen = Math.min(TAIL_CHUNK_BYTES, pos);
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos - readLen);
      pos -= readLen;
      bytesRead += readLen;
      const text = buf.toString("utf8") + pending;

      // The bytes BEFORE the first \n are still partial — its head
      // lives in the unread region. Save it for the next iteration.
      const firstNl = text.indexOf("\n");
      if (firstNl === -1) {
        // Whole chunk is one ongoing partial line. Keep accumulating.
        pending = text;
        continue;
      }
      pending = text.slice(0, firstNl);
      const rest = text.slice(firstNl + 1);

      // Lines after the first \n are guaranteed complete in this
      // buffer; well-formed JSONL ends every record with \n so the
      // trailing element is "" — drop it.
      const lines = rest.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (consumeLine(lines[i]) === "done") {
          earlyExit = true;
          break;
        }
      }
    }

    // Loop exits at pos === 0 (or budget exhausted). The remaining
    // `pending` is the very-first line of the file — process it iff
    // we still need data and we actually hit byte 0.
    if (!earlyExit && pos === 0 && pending) {
      // Strip a possible leading BOM and any stray \r at the end.
      const head = pending.replace(/^﻿/, "").replace(/\r$/, "");
      if (head) consumeLine(head);
    }

    return { lastAssistantText, recentToolUses: toolUses };
  } catch {
    return empty;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
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
 * Spawn the retry. Crash gate carries an exit-code + last-assistant-
 * text + recent-tool-uses block at the top of the prompt; everything
 * else (eligibility, role suffix, sibling parent linkage, worktree
 * inheritance, lifecycle wiring) is shared across all retry gates and
 * lives in `libs/retrySpawn.ts`.
 */
async function spawnRetryRun(args: {
  taskId: string;
  failedRun: Run;
  exitCode: number | null;
  nextAttempt: number;
}): Promise<{ sessionId: string; run: Run } | null> {
  const { taskId, failedRun, exitCode, nextAttempt } = args;

  // Resolve the same cwd the failed run used so the .jsonl tail-read
  // for context picks up the right transcript (worktree path takes
  // precedence over the live tree, same as the spawn cwd).
  const md = readBridgeMd();
  const liveRepoCwd = resolveRepoCwd(md, BRIDGE_ROOT, failedRun.repo);
  if (!liveRepoCwd) return null;
  const transcriptCwd = failedRun.worktreePath ?? liveRepoCwd;

  const sessionContext = readFailedSessionContext(failedRun.sessionId, transcriptCwd);
  const killedByUser = looksKilledByUser(failedRun);
  const ctxBlock = renderRetryContextBlock({
    exitCode,
    lastAssistantText: sessionContext.lastAssistantText,
    recentToolUses: sessionContext.recentToolUses,
    killedByUser,
  });

  return spawnRetry({
    taskId,
    finishedRun: failedRun,
    gate: "crash",
    ctxBlock,
    logLabel: "auto-retry",
    precomputedAttempt: { nextAttempt },
  });
}

/**
 * Public entry point — called from `wireRunLifecycle` after a child
 * run has been marked failed. Re-checks meta.json (the failed run is
 * already in there with status `failed`), validates eligibility, and
 * spawns a single retry. Always non-throwing: a retry-path bug must
 * not take down the lifecycle wire.
 */
export function maybeScheduleRetry(args: ScheduleArgs & { exitCode: number | null }): void {
  // Wrap in an async IIFE so callers (lifecycle exit handlers) can stay
  // sync. Errors are logged rather than re-thrown — a retry-path bug
  // must not take down the lifecycle wire.
  void (async () => {
    try {
      const { taskId, failedRun, exitCode } = args;
      const elig = isEligibleForRetry(taskId, failedRun);
      if (!("nextAttempt" in elig)) {
        // Quiet — most failed runs are ineligible (no parent, already a
        // retry past budget, etc.) and we don't want to spam logs.
        return;
      }
      const result = await spawnRetryRun({
        taskId,
        failedRun,
        exitCode,
        nextAttempt: elig.nextAttempt,
      });
      if (!result) return;
      emitRetried(taskId, result.run, failedRun.sessionId);
      console.log(
        `[auto-retry] ${taskId}: spawned ${result.sessionId} (role=${result.run.role}, attempt=${elig.nextAttempt}) for failed ${failedRun.sessionId}`,
      );
    } catch (e) {
      console.error("auto-retry scheduling crashed", e);
    }
  })();
}
