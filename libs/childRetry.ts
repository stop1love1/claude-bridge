import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { emitRetried, readMeta, type Run } from "./meta";
import { resolveRepoCwd } from "./repos";
import { projectDirFor } from "./sessions";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { getApp } from "./apps";
import { spawnRetry } from "./retrySpawn";
import { checkEligibility } from "./retryLadder";
import { logError, logInfo } from "./log";


const MAX_LAST_ASSISTANT_CHARS = 2000;
const MAX_TOOL_INPUT_SNIPPET = 200;
const MAX_TOOL_USE_ENTRIES = 5;
const KILL_DETECTION_WINDOW_MS = 5000;

export interface ToolUseEntry {
  tool: string;
  input: string;
}

interface ScheduleArgs {
  taskId: string;
  failedRun: Run;
}

export function isEligibleForRetry(
  taskId: string,
  failedRun: Run,
): { nextAttempt: number } | { reason: string } {
  if (failedRun.status === "cancelled") return { reason: "cancelled by operator" };
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

  const consumeLine = (line: string): "done" | "continue" => {
    if (!line || !line.trim()) return "continue";
    let obj: { type?: string; message?: { content?: unknown } };
    try { obj = JSON.parse(line) as typeof obj; } catch { return "continue"; }
    if (obj.type !== "assistant") return "continue";

    const content = obj.message?.content;
    if (Array.isArray(content)) {
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
    let pending = "";
    let earlyExit = false;

    while (pos > 0 && bytesRead < TAIL_MAX_BYTES && !earlyExit) {
      const readLen = Math.min(TAIL_CHUNK_BYTES, pos);
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos - readLen);
      pos -= readLen;
      bytesRead += readLen;
      const text = buf.toString("utf8") + pending;

      const firstNl = text.indexOf("\n");
      if (firstNl === -1) {
        pending = text;
        continue;
      }
      pending = text.slice(0, firstNl);
      const rest = text.slice(firstNl + 1);

      const lines = rest.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (consumeLine(lines[i]) === "done") {
          earlyExit = true;
          break;
        }
      }
    }

    if (!earlyExit && pos === 0 && pending) {
      const head = pending.replace(/^﻿/, "").replace(/\r$/, "");
      if (head) consumeLine(head);
    }

    return { lastAssistantText, recentToolUses: toolUses };
  } catch {
    return empty;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { }
    }
  }
}

function looksKilledByUser(failedRun: Run): boolean {
  if (failedRun.status !== "failed") return false;
  if (!failedRun.startedAt || !failedRun.endedAt) return false;
  const start = new Date(failedRun.startedAt).getTime();
  const end = new Date(failedRun.endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return end - start < KILL_DETECTION_WINDOW_MS;
}

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

async function spawnRetryRun(args: {
  taskId: string;
  failedRun: Run;
  exitCode: number | null;
  nextAttempt: number;
}): Promise<{ sessionId: string; run: Run } | null> {
  const { taskId, failedRun, exitCode, nextAttempt } = args;

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

export function maybeScheduleRetry(args: ScheduleArgs & { exitCode: number | null }): void {
  void (async () => {
    try {
      const { taskId, failedRun, exitCode } = args;
      const elig = isEligibleForRetry(taskId, failedRun);
      if (!("nextAttempt" in elig)) {
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
      logInfo(
        "auto-retry",
        `${taskId}: spawned ${result.sessionId} (role=${result.run.role}, attempt=${elig.nextAttempt}) for failed ${failedRun.sessionId}`,
      );
    } catch (e) {
      logError("auto-retry", "auto-retry scheduling crashed", e);
    }
  })();
}
