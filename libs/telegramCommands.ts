
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isUserClientConfigured,
  sendUserMessage,
  subscribeUserMessages,
  type InboundMessage,
} from "./telegramUserClient";
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
} from "./tasksStore";
import { readMeta, applyManyRuns, readIntake, setIntake } from "./meta";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { spawnCoordinatorForTask } from "./coordinator";
import { continueCoordinator } from "./planGateLifecycle";
import { readPlanGateConfig } from "./planGateConfig";
import { denyTaskToolNames, resumeClaude } from "./spawn";
import { killChild } from "./spawnRegistry";
import { releaseRepoReservation } from "./repoReservation";
import { settleTaskAfterKill } from "./settleTaskAfterKill";
import { autoDetectApps, loadApps } from "./apps";
import {
  isValidTaskId,
  SECTION_BLOCKED,
  SECTION_DOING,
  SECTION_DONE,
  SECTION_TODO,
  type TaskSection,
} from "./tasks";
import { getManifestTelegramSettings } from "./apps";
import {
  answer as answerPermission,
  listAllPending,
  type PendingRequest,
} from "./permissionStore";
import {
  listPendingLogins,
  answerPendingLogin,
  type PendingLogin,
} from "./loginApprovals";
import {
  loadDetectInput,
  refreshScope,
  writeScopeCache,
  heuristicDetector,
} from "./detect";
import { detectWithLLM } from "./detect/llm";
import { getDetectSource } from "./detect";
import { scanAppWithClaude } from "./scanApp";
import { updateAppDescription } from "./apps";
import { resolveRepoCwd } from "./repos";
import { projectDirFor } from "./sessions";
import { addUsage, sumUsageFromJsonl, type SessionUsage } from "./sessionUsage";
import { sendTelegramApiMessage } from "./telegramSendRetry";
import { logInfo, logWarn } from "./log";

const TG_HOST = "https://api.telegram.org";
const POLL_TIMEOUT_S = 25;
const POLL_RESTART_DELAY_MS = 5_000;
const REPLY_MAX = 3500;

interface PollerState {
  running: boolean;
  offset: number;
  abort: AbortController | null;
}

const G = globalThis as unknown as { __bridgeTelegramPoller?: PollerState };
const poller: PollerState =
  G.__bridgeTelegramPoller ?? {
    running: false,
    offset: 0,
    abort: null,
  };
G.__bridgeTelegramPoller = poller;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat: { id: number };
    text?: string;
    from?: { username?: string; first_name?: string };
  };
}

export function startTelegramCommandPoller(): void {
  if (poller.running) return;
  const cfg = telegramConfig();
  if (!cfg) return;
  poller.running = true;
  poller.abort = new AbortController();
  void publishCommandsToBotFather(cfg.token).catch((err) => {
    logWarn("telegram-cmd", "setMyCommands failed", { error: (err as Error).message });
  });
  void runLoop(cfg);
}

export function stopTelegramCommandPoller(): void {
  if (!poller.running) return;
  poller.running = false;
  if (poller.abort) {
    poller.abort.abort();
    poller.abort = null;
  }
}

async function runLoop(cfg: { token: string; chatId: string }): Promise<void> {
  while (poller.running) {
    const live = telegramConfig();
    if (!live) {
      poller.running = false;
      break;
    }
    cfg = live;

    try {
      const updates = await fetchUpdates(cfg.token, poller.offset);
      for (const up of updates) {
        if (up.update_id >= poller.offset) {
          poller.offset = up.update_id + 1;
        }
        try {
          await handleUpdate(up, cfg);
        } catch (err) {
          logWarn("telegram-cmd", "handler crashed", { error: (err as Error).message });
        }
      }
    } catch (err) {
      if (!poller.running) break;
      const msg = (err as Error).message;
      if (!/abort/i.test(msg)) {
        logWarn("telegram-cmd", "poll error", { error: msg });
        await delay(POLL_RESTART_DELAY_MS);
      }
    }
  }
}

export function buildPollSignal(
  shutdown: AbortSignal | undefined,
  deadlineMs: number = POLL_TIMEOUT_S * 1000 + 10_000,
): AbortSignal {
  const deadline = AbortSignal.timeout(deadlineMs);
  return shutdown ? AbortSignal.any([shutdown, deadline]) : deadline;
}

export async function fetchUpdates(
  token: string,
  offset: number,
): Promise<TelegramUpdate[]> {
  const url =
    `${TG_HOST}/bot${encodeURIComponent(token)}/getUpdates` +
    `?timeout=${POLL_TIMEOUT_S}` +
    `&offset=${offset}` +
    `&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
  const r = await fetch(url, {
    method: "GET",
    signal: buildPollSignal(poller.abort?.signal),
  });
  if (!r.ok) {
    throw new Error(`getUpdates HTTP ${r.status}`);
  }
  const body = (await r.json()) as { ok?: boolean; result?: TelegramUpdate[] };
  if (!body.ok || !Array.isArray(body.result)) {
    throw new Error("getUpdates returned ok=false");
  }
  return body.result;
}

async function handleUpdate(
  up: TelegramUpdate,
  cfg: { token: string; chatId: string },
): Promise<void> {
  const msg = up.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== cfg.chatId) {
    logWarn(
      "telegram-cmd",
      `ignoring message from non-allowlisted chat ${msg.chat.id}`,
    );
    return;
  }
  const text = msg.text.trim();
  if (!text) return;

  const reply = await smartDispatch(text);
  if (reply) await sendReply(cfg, buildReplyBody(reply), msg.message_id);
}

export interface CommandDef {
  name: string;
  description: string;
  handler(args: string[], rawTail: string): Promise<string>;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "help",
    description: "List all bridge commands",
    handler: async () => renderHelp(),
  },
  {
    name: "start",
    description: "Welcome + command list",
    handler: async () => `Welcome to Claude Bridge\\.\n\n${renderHelp()}`,
  },
  {
    name: "tasks",
    description: "List all open tasks (TODO + DOING + BLOCKED)",
    handler: async () => renderTasks(["TODO", "DOING", "BLOCKED"]),
  },
  {
    name: "doing",
    description: "List tasks currently in DOING",
    handler: async () => renderTasks(["DOING"]),
  },
  {
    name: "blocked",
    description: "List tasks currently BLOCKED",
    handler: async () => renderTasks(["BLOCKED"]),
  },
  {
    name: "todo",
    description: "List tasks in TODO",
    handler: async () => renderTasks(["TODO"]),
  },
  {
    name: "review",
    description: "List tasks awaiting review (DONE — not yet archived)",
    handler: async () => renderTasks([SECTION_DONE]),
  },
  {
    name: "active",
    description: "List currently running sessions",
    handler: async () => renderActive(),
  },
  {
    name: "pending",
    description: "List pending permission requests",
    handler: async () => renderPending(),
  },
  {
    name: "apps",
    description: "List registered apps",
    handler: async () => renderApps(),
  },
  {
    name: "task",
    description: "Show details for a task — usage: /task <id>",
    handler: async (args) => renderTaskDetail(args[0]),
  },
  {
    name: "runs",
    description: "List all runs of a task — usage: /runs <id>",
    handler: async (args) => renderRuns(args[0]),
  },
  {
    name: "summary",
    description: "Read summary.md for a task — usage: /summary <id>",
    handler: async (args) => commandSummary(args[0]),
  },
  {
    name: "report",
    description: "Read a child report — usage: /report <id> <role>",
    handler: async (args) => commandReport(args[0], args[1]),
  },
  {
    name: "usage",
    description: "Token usage for a task — usage: /usage <id>",
    handler: async (args) => commandUsage(args[0]),
  },
  {
    name: "new",
    description: "Create a new task — usage: /new <description>",
    handler: async (_args, rawTail) => commandNew(rawTail),
  },
  {
    name: "done",
    description: "Mark a task as DONE — usage: /done <id>",
    handler: async (args) => commandDone(args[0]),
  },
  {
    name: "reopen",
    description: "Reopen a DONE task back to DOING — usage: /reopen <id>",
    handler: async (args) => commandReopen(args[0]),
  },
  {
    name: "continue",
    description: "Resume the existing coordinator for a task — usage: /continue <id>",
    handler: async (args) => commandContinue(args[0]),
  },
  {
    name: "retry",
    description: "Spawn a fresh coordinator (keeps run history) — usage: /retry <id>",
    handler: async (args) => commandRetry(args[0]),
  },
  {
    name: "clear",
    description: "Clear runs + spawn fresh coordinator — usage: /clear <id>",
    handler: async (args) => commandClear(args[0]),
  },
  {
    name: "kill",
    description: "Kill all running sessions of a task — usage: /kill <id>",
    handler: async (args) => commandKill(args[0]),
  },
  {
    name: "delete",
    description: "Delete a task and its sessions — usage: /delete <id>",
    handler: async (args) => commandDelete(args[0]),
  },
  {
    name: "refresh",
    description: "Re-run scope detection — usage: /refresh <id>",
    handler: async (args) => commandRefreshScope(args[0]),
  },
  {
    name: "plan",
    description: "Show plan intake status/summary/questions — usage: /plan <id>",
    handler: async (args) => commandPlanShow(args[0]),
  },
  {
    name: "approve",
    description: "Approve the current plan — usage: /approve <id>",
    handler: async (args) => commandPlanApprove(args[0]),
  },
  {
    name: "replan",
    description: "Request plan changes with a note — usage: /replan <id> <note>",
    handler: async (_args, rawTail) => {
      const { id, rest } = splitIdAndRest(rawTail);
      return commandPlanReplan(id, rest);
    },
  },
  {
    name: "allow",
    description: "Allow a pending permission — usage: /allow <reqId>",
    handler: async (args) => commandPermissionAnswer(args[0], "allow"),
  },
  {
    name: "deny",
    description: "Deny a pending permission — usage: /deny <reqId>",
    handler: async (args) => commandPermissionAnswer(args[0], "deny"),
  },
  {
    name: "logins",
    description: "List pending device-login approvals",
    handler: async () => renderPendingLogins(),
  },
  {
    name: "approvelogin",
    description: "Approve a pending device login — usage: /approvelogin <idPrefix>",
    handler: async (args) => commandLoginAnswer(args[0], "approved"),
  },
  {
    name: "denylogin",
    description: "Deny a pending device login — usage: /denylogin <idPrefix>",
    handler: async (args) => commandLoginAnswer(args[0], "denied"),
  },
  {
    name: "scan",
    description: "Auto-detect siblings, or rescan an app's description — usage: /scan [app]",
    handler: async (args) => commandScan(args[0]),
  },
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c] as const));

export async function smartDispatch(rawText: string): Promise<string> {
  const trimmed = rawText.trim();
  if (!trimmed) return "Empty message — send /help for the command list.";
  if (trimmed.startsWith("/")) {
    return dispatchCommand(trimmed);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { routeNaturalLanguage } = require("./telegramIntent") as typeof import("./telegramIntent");
  let result;
  try {
    result = await routeNaturalLanguage(trimmed);
  } catch (err) {
    logWarn("telegram-cmd", "intent router crashed", { error: (err as Error).message });
    result = null;
  }
  if (!result) {
    return [
      "Sorry — I couldn't route that to a bridge command (LLM unavailable or refused).",
      "Send /help to see the slash-command catalog.",
    ].join("\n");
  }

  const { command, reply, confidence } = result;
  if (!command) {
    return reply || "Send /help to see what I can do.";
  }

  let dispatchOut: string;
  try {
    dispatchOut = await dispatchCommand(command);
  } catch (err) {
    dispatchOut = `Error: ${(err as Error).message}`;
  }
  const confidenceTag = confidence === "high" ? "" : ` (confidence: ${confidence})`;
  const header = reply
    ? `${reply}${confidenceTag}\n\n→ \`${command}\`\n`
    : `→ \`${command}\`${confidenceTag}\n`;
  return `${header}${dispatchOut}`;
}

export async function dispatchCommand(rawText: string): Promise<string> {
  const trimmed = rawText.trim();
  const headEnd = trimmed.search(/\s/);
  const head = headEnd === -1 ? trimmed : trimmed.slice(0, headEnd);
  const rawTail = headEnd === -1 ? "" : trimmed.slice(headEnd + 1).trim();
  const cmdName = head.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
  const args = rawTail.length > 0 ? rawTail.split(/\s+/) : [];
  const def = COMMAND_BY_NAME.get(cmdName);
  if (!def) {
    return `Unknown command: \`/${escapeMarkdownV2(cmdName)}\`\\. Send /help\\.`;
  }
  try {
    return await def.handler(args, rawTail);
  } catch (err) {
    return `Error: ${escapeMarkdownV2((err as Error).message)}`;
  }
}


function renderHelp(): string {
  const lines = ["*Bridge commands:*", ""];
  for (const c of COMMANDS) {
    lines.push(`/${c.name} — ${c.description}`);
  }
  return lines.join("\n");
}

export const LIST_CAP = 20;

export function capListLines(lines: string[], cap: number): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `… +${lines.length - cap} more`];
}

function renderTasks(sections: TaskSection[]): string {
  const all = listTasks();
  const filtered = all
    .filter((t) => sections.includes(t.section))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  if (filtered.length === 0) {
    return `(no tasks in ${sections.join(" / ")})`;
  }
  const rows: string[] = [];
  for (const t of filtered) {
    const icon = sectionIcon(t.section);
    const app = t.app ? ` · \`${t.app}\`` : "";
    const titleEsc = escapeMarkdownV2(truncate(t.title, 80));
    rows.push(`${icon} \`${t.id}\`${escapeMarkdownV2(app)} — ${titleEsc}`);
  }
  const lines: string[] = [`*${filtered.length} task(s):*`, "", ...capListLines(rows, LIST_CAP)];
  return lines.join("\n");
}

function renderActive(): string {
  const all = listTasks();
  type ActiveRow = { taskId: string; role: string; repo: string; sessionId: string };
  const active: ActiveRow[] = [];
  for (const t of all) {
    const meta = readMeta(join(SESSIONS_DIR, t.id));
    if (!meta) continue;
    for (const r of meta.runs) {
      if (r.status === "running") {
        active.push({
          taskId: t.id,
          role: r.role,
          repo: r.repo,
          sessionId: r.sessionId,
        });
      }
    }
  }
  if (active.length === 0) return "(no running sessions)";
  const rows = active.map((r) => {
    const role = escapeMarkdownV2(r.role);
    const repo = escapeMarkdownV2(r.repo);
    return `🟢 \`${r.taskId}\` — ${role} @ ${repo} \\(${r.sessionId.slice(0, 8)}\\)`;
  });
  const lines: string[] = [
    `*${active.length} active session(s):*`,
    "",
    ...capListLines(rows, LIST_CAP),
  ];
  return lines.join("\n");
}

function renderApps(): string {
  const apps = loadApps();
  if (apps.length === 0) return "(no apps registered)";
  const all = listTasks();
  const rows: string[] = [];
  for (const a of apps) {
    const own = all.filter((t) => t.app === a.name);
    const doing = own.filter((t) => t.section === "DOING").length;
    const todo = own.filter((t) => t.section === "TODO").length;
    const blocked = own.filter((t) => t.section === "BLOCKED").length;
    rows.push(
      `📦 \`${escapeMarkdownV2(a.name)}\` — ${doing} doing · ${todo} todo · ${blocked} blocked`,
    );
  }
  const lines: string[] = [`*${apps.length} app(s):*`, "", ...capListLines(rows, LIST_CAP)];
  return lines.join("\n");
}

function renderTaskDetail(idArg: string | undefined): string {
  if (!idArg) return "Usage: `/task t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${escapeMarkdownV2(idArg)}\``;
  const t = getTask(idArg);
  if (!t) return `Task not found: \`${idArg}\``;
  const meta = readMeta(join(SESSIONS_DIR, idArg));
  const runs = meta?.runs ?? [];
  const running = runs.filter((r) => r.status === "running").length;
  const done = runs.filter((r) => r.status === "done").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const lines = [
    `${sectionIcon(t.section)} *${escapeMarkdownV2(truncate(t.title, 80))}*`,
    `\`${t.id}\` · ${escapeMarkdownV2(t.section)}${t.app ? ` · \`${escapeMarkdownV2(t.app)}\`` : ""}`,
    "",
    `Runs: ${runs.length} \\(${running} running, ${done} done, ${failed} failed\\)`,
  ];
  if (t.body.trim()) {
    lines.push("", "*Body:*", "```", truncate(t.body, 600), "```");
  }
  return lines.join("\n");
}


async function commandDone(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/done t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const t = await updateTask(idArg, {
    section: SECTION_DONE,
    checked: true,
  });
  if (!t) return `Task not found: \`${idArg}\``;
  return `✅ Marked \`${idArg}\` DONE: ${escapeMarkdownV2(truncate(t.title, 80))}`;
}

async function commandReopen(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/reopen t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const t = await updateTask(idArg, { section: "DOING", checked: false });
  if (!t) return `Task not found: \`${idArg}\``;
  return `🔄 Reopened \`${idArg}\` → DOING: ${escapeMarkdownV2(truncate(t.title, 80))}`;
}

async function commandRetry(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/retry t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const task = getTask(idArg);
  if (!task) return `Task not found: \`${idArg}\``;
  const sessionId = await spawnCoordinatorForTask(task);
  if (!sessionId) return `Spawn failed for \`${idArg}\` \\(see server logs\\)`;
  return `🚀 Spawned coordinator for \`${idArg}\` \\(\`${sessionId.slice(0, 8)}\`\\)`;
}

async function commandKill(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/kill t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const meta = readMeta(join(SESSIONS_DIR, idArg));
  if (!meta) return `Task not found: \`${idArg}\``;
  const running = meta.runs.filter((r) => r.status === "running");
  if (running.length === 0) return `No running sessions for \`${idArg}\``;
  let killed = 0;
  for (const r of running) {
    if (killChild(r.sessionId)) killed += 1;
  }
  await applyManyRuns(
    join(SESSIONS_DIR, idArg),
    running.map((r) => ({
      sessionId: r.sessionId,
      patch: { status: "cancelled", endedAt: new Date().toISOString() },
    })),
  );
  for (const r of running) releaseRepoReservation(r.repo, r.sessionId);
  const parkedIn = await settleTaskAfterKill(idArg);
  const parked = parkedIn ? ` — moved to \`${parkedIn}\`` : "";
  return `🛑 Killed ${killed} of ${running.length} session\\(s\\) for \`${idArg}\`${parked}`;
}

async function commandDelete(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/delete t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const r = await deleteTask(idArg);
  if (!r.ok) return `Task not found: \`${idArg}\``;
  return `🗑 Deleted \`${idArg}\` \\(${r.sessionsDeleted} session file\\(s\\) removed\\)`;
}

async function commandNew(rawTail: string): Promise<string> {
  const trimmed = rawTail.trim();
  if (!trimmed) return "Usage: `/new <description>` \\(first line becomes the title\\)";
  const firstLine = trimmed.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const title = firstLine
    ? (firstLine.length > 100 ? firstLine.slice(0, 100).trimEnd() + "…" : firstLine)
    : "(untitled)";
  const task = createTask({ title, body: trimmed, app: null });

  try {
    const sessionsDir = join(SESSIONS_DIR, task.id);
    const detectInput = loadDetectInput({
      taskBody: task.body,
      taskTitle: task.title,
      pinnedRepo: task.app ?? null,
    });
    const baseline = await heuristicDetector.detect(detectInput);
    await writeScopeCache(sessionsDir, baseline);
    const mode = getDetectSource();
    if (mode === "auto" || mode === "llm") {
      void (async () => {
        try {
          const upgraded = await detectWithLLM(detectInput);
          if (upgraded) await writeScopeCache(sessionsDir, upgraded);
        } catch (err) {
          logWarn("telegram-cmd", "/new LLM upgrade failed", { error: (err as Error)?.message ?? String(err) });
        }
      })();
    }
  } catch (err) {
    logWarn("telegram-cmd", "/new detection failed (non-fatal)", { error: (err as Error)?.message ?? String(err) });
  }

  void spawnCoordinatorForTask(task);
  return `📝 Created \`${task.id}\`: ${escapeMarkdownV2(truncate(task.title, 80))}`;
}

async function commandContinue(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/continue t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const task = getTask(idArg);
  if (!task) return `Task not found: \`${idArg}\``;
  const meta = readMeta(join(SESSIONS_DIR, idArg));
  const coord = meta?.runs.find((r) => r.role === "coordinator");
  if (coord) {
    const message =
      `Continue from where you left off for bridge task ${idArg}. Read sessions/${idArg}/meta.json to see which child agents are still 'running', which 'done', and which 'failed'. If all children are done, finalize per prompts/coordinator-playbook.md §5. Otherwise re-orchestrate as needed.`;
    resumeClaude(BRIDGE_ROOT, coord.sessionId, message, {
      mode: "bypassPermissions",
      disallowedTools: denyTaskToolNames(),
    });
    return `▶️ Resumed coordinator for \`${idArg}\` \\(\`${coord.sessionId.slice(0, 8)}\`\\)`;
  }
  const sid = await spawnCoordinatorForTask(task);
  if (!sid) return `Spawn failed for \`${idArg}\` \\(see server logs\\)`;
  return `🚀 No prior coordinator — spawned new for \`${idArg}\` \\(\`${sid.slice(0, 8)}\`\\)`;
}

async function commandClear(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/clear t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const task = getTask(idArg);
  if (!task) return `Task not found: \`${idArg}\``;
  const sid = await spawnCoordinatorForTask(task);
  if (!sid) return `Spawn failed for \`${idArg}\` \\(see server logs\\)`;
  return `🧹 Cleared \`${idArg}\`: spawned fresh coordinator \\(\`${sid.slice(0, 8)}\`\\)`;
}

async function commandSummary(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/summary t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const path = join(SESSIONS_DIR, idArg, "summary.md");
  if (!existsSync(path)) return `No summary yet for \`${idArg}\``;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return `Summary is empty for \`${idArg}\``;
  return [
    `*Summary \\(\`${idArg}\`\\):*`,
    "",
    "```",
    truncate(text, 2800),
    "```",
  ].join("\n");
}

const ROLE_ARG_RE = /^[a-z0-9_-]{1,32}$/i;

async function commandReport(
  idArg: string | undefined,
  roleArg: string | undefined,
): Promise<string> {
  if (!idArg || !roleArg) {
    return "Usage: `/report t_YYYYMMDD_NNN <role>` \\(role like `coder`, `reviewer`\\)";
  }
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  if (!ROLE_ARG_RE.test(roleArg)) {
    return `Invalid role: must match \`[a-z0-9_-]{1,32}\``;
  }
  const dir = join(SESSIONS_DIR, idArg, "reports");
  if (!existsSync(dir)) return `No reports dir for \`${idArg}\``;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return `Cannot list reports for \`${idArg}\``;
  }
  const roleLower = roleArg.toLowerCase();
  const match = files.find((f) => f.toLowerCase().startsWith(`${roleLower}-`));
  if (!match) {
    if (files.length === 0) return `No reports yet for \`${idArg}\``;
    const list = files.map((f) => `\`${escapeMarkdownV2(f.replace(/\.md$/, ""))}\``).join(", ");
    return `No report matching \`${escapeMarkdownV2(roleLower)}\`\\. Available: ${list}`;
  }
  const text = readFileSync(join(dir, match), "utf8").trim();
  return [
    `*Report \\(\`${escapeMarkdownV2(match.replace(/\.md$/, ""))}\`\\):*`,
    "",
    "```",
    truncate(text, 2800),
    "```",
  ].join("\n");
}

async function commandUsage(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/usage t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const dir = join(SESSIONS_DIR, idArg);
  const meta = readMeta(dir);
  if (!meta) return `Task not found: \`${idArg}\``;

  const bridgeMd = readBridgeMd();

  let total: SessionUsage = {
    inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    turns: 0,
  };
  for (const r of meta.runs) {
    const cwd = bridgeMd ? resolveRepoCwd(bridgeMd, BRIDGE_ROOT, r.repo) : null;
    const u = cwd
      ? sumUsageFromJsonl(join(projectDirFor(cwd), `${r.sessionId}.jsonl`))
      : { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0 };
    total = addUsage(total, u);
  }

  const fmt = (n: number) => n.toLocaleString("en-US");
  return [
    `*Usage \\(\`${idArg}\`\\):*`,
    "",
    `Runs: ${meta.runs.length}`,
    `Turns: ${total.turns}`,
    `Input: ${escapeMarkdownV2(fmt(total.inputTokens))} tok`,
    `Output: ${escapeMarkdownV2(fmt(total.outputTokens))} tok`,
    `Cache create: ${escapeMarkdownV2(fmt(total.cacheCreationTokens))} tok`,
    `Cache read: ${escapeMarkdownV2(fmt(total.cacheReadTokens))} tok`,
  ].join("\n");
}

async function commandRefreshScope(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/refresh t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const dir = join(SESSIONS_DIR, idArg);
  const meta = readMeta(dir);
  if (!meta) return `Task not found: \`${idArg}\``;
  const scope = await refreshScope(dir, () =>
    loadDetectInput({
      taskBody: meta.taskBody,
      taskTitle: meta.taskTitle,
      pinnedRepo: meta.taskApp ?? null,
    }),
  );
  const top = scope.repos[0];
  return [
    `🔍 Refreshed scope for \`${idArg}\``,
    `Source: \`${scope.source}\` · Confidence: \`${scope.confidence}\``,
    top
      ? `Top repo: \`${escapeMarkdownV2(top.name)}\` \\(score ${top.score}\\)`
      : "Top repo: \\(none\\)",
  ].join("\n");
}


function splitIdAndRest(rawTail: string): { id: string | undefined; rest: string | undefined } {
  const trimmed = rawTail.trim();
  if (!trimmed) return { id: undefined, rest: undefined };
  const sp = trimmed.search(/\s/);
  if (sp === -1) return { id: trimmed, rest: undefined };
  const rest = trimmed.slice(sp + 1).trim();
  return { id: trimmed.slice(0, sp), rest: rest.length > 0 ? rest : undefined };
}

export async function commandPlanShow(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/plan t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const dir = join(SESSIONS_DIR, idArg);
  const meta = readMeta(dir);
  if (!meta) return `Task not found: \`${idArg}\``;
  const intake = readIntake(dir);
  if (!intake || intake.status === "none") {
    return `⚠️ No plan to act on for \`${idArg}\``;
  }
  const cfg = readPlanGateConfig();
  const lines = [
    `📋 Plan for \`${idArg}\``,
    `Status: \`${escapeMarkdownV2(intake.status)}\` · Rounds: ${intake.rounds}/${cfg.maxClarifyRounds}`,
  ];
  if (intake.summary) {
    lines.push("", `Summary: ${escapeMarkdownV2(truncate(intake.summary, 800))}`);
  }
  if (intake.questions.length > 0) {
    lines.push("", "Questions:");
    const rows = intake.questions.map((q) => `- ${escapeMarkdownV2(q.text)}`);
    lines.push(...capListLines(rows, LIST_CAP));
  }
  return lines.join("\n");
}

export async function commandPlanApprove(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/approve t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const dir = join(SESSIONS_DIR, idArg);
  const meta = readMeta(dir);
  if (!meta) return `Task not found: \`${idArg}\``;
  const intake = readIntake(dir);
  if (!intake || intake.status === "none") {
    return `⚠️ No plan to act on for \`${idArg}\``;
  }
  if (intake.status === "approved") {
    return `✅ Plan already approved for \`${idArg}\``;
  }
  const nowIso = new Date().toISOString();
  await setIntake(dir, {
    status: "approved",
    approvedBy: { kind: "operator", label: "telegram", at: nowIso },
  });
  await continueCoordinator(idArg, dir, intake.summary);
  return `✅ Plan approved for \`${idArg}\``;
}

export async function commandPlanReplan(
  idArg: string | undefined,
  note: string | undefined,
): Promise<string> {
  if (!idArg || !note) {
    return "Usage: `/replan t_YYYYMMDD_NNN <note>`";
  }
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const dir = join(SESSIONS_DIR, idArg);
  const meta = readMeta(dir);
  if (!meta) return `Task not found: \`${idArg}\``;
  const intake = readIntake(dir);
  if (!intake || intake.status === "none") {
    return `⚠️ No plan to act on for \`${idArg}\``;
  }
  const cfg = readPlanGateConfig();
  if (intake.rounds >= cfg.maxClarifyRounds) {
    return `🚫 \`${idArg}\`: re-planning is capped at ${cfg.maxClarifyRounds} round(s) — approve or reject the current plan`;
  }
  const rec = await setIntake(dir, { status: "planning", rounds: intake.rounds + 1 });
  await continueCoordinator(idArg, dir, `Operator feedback: ${note}`, { replan: true });
  return `🔁 Re-plan requested for \`${idArg}\` \\(round ${rec?.rounds ?? intake.rounds + 1}/${cfg.maxClarifyRounds}\\)`;
}

async function commandPermissionAnswer(
  reqIdArg: string | undefined,
  decision: "allow" | "deny",
): Promise<string> {
  if (!reqIdArg) return `Usage: \`/${decision} <reqId>\` \\(from a 🔐 ping\\)`;
  const lookup = reqIdArg.trim().toLowerCase();
  if (lookup.length < 6) {
    return "Request id is too short \\(needs ≥ 6 chars to avoid ambiguity\\)";
  }
  const matches = listAllPending().filter((r: PendingRequest) =>
    r.requestId.toLowerCase().startsWith(lookup),
  );
  if (matches.length === 0) {
    return `No pending request matching \`${escapeMarkdownV2(reqIdArg)}\``;
  }
  if (matches.length > 1) {
    const previews = matches
      .slice(0, 3)
      .map((r) => `\`${r.requestId.slice(0, 12)}\``)
      .join(", ");
    return `Ambiguous \`${escapeMarkdownV2(reqIdArg)}\` matches ${matches.length}: ${previews} \\(use a longer prefix\\)`;
  }
  const target = matches[0];
  const updated = answerPermission(target.sessionId, target.requestId, decision);
  if (!updated) return `Request \`${escapeMarkdownV2(reqIdArg)}\` no longer pending`;
  const icon = decision === "allow" ? "✅" : "🛑";
  return `${icon} ${decision === "allow" ? "Allowed" : "Denied"} \`${escapeMarkdownV2(target.tool)}\` for session \`${target.sessionId.slice(0, 8)}\``;
}

async function commandLoginAnswer(
  idArg: string | undefined,
  decision: "approved" | "denied",
): Promise<string> {
  const cmd = decision === "approved" ? "approvelogin" : "denylogin";
  if (!idArg) return `Usage: \`/${cmd} <idPrefix>\` \\(from a 🔐 login ping or /logins\\)`;
  const lookup = idArg.trim().toLowerCase();
  if (lookup.length < 6) {
    return "Login id is too short \\(needs ≥ 6 chars to avoid ambiguity\\)";
  }
  const matches = listPendingLogins().filter((p: PendingLogin) =>
    p.id.toLowerCase().startsWith(lookup),
  );
  if (matches.length === 0) {
    return `No pending login matching \`${escapeMarkdownV2(idArg)}\``;
  }
  if (matches.length > 1) {
    const previews = matches
      .slice(0, 3)
      .map((p) => `\`${p.id.slice(0, 12)}\``)
      .join(", ");
    return `Ambiguous \`${escapeMarkdownV2(idArg)}\` matches ${matches.length}: ${previews} \\(use a longer prefix\\)`;
  }
  const target = matches[0];
  const updated = answerPendingLogin(target.id, decision);
  if (!updated) return `Login \`${escapeMarkdownV2(idArg)}\` no longer pending`;
  const icon = decision === "approved" ? "✅" : "🛑";
  const ua = escapeMarkdownV2(truncate(target.userAgent, 40));
  return `${icon} ${decision === "approved" ? "Approved" : "Denied"} device login \`${target.id.slice(0, 8)}\` \\(${ua}\\)`;
}

async function commandScan(appArg: string | undefined): Promise<string> {
  if (!appArg) {
    const r = await autoDetectApps();
    if (r.added.length === 0) {
      return `🔎 No new apps detected \\(${r.skipped.length} skipped\\)`;
    }
    const names = r.added.map((a) => `\`${escapeMarkdownV2(a.name)}\``).join(", ");
    return `📦 Auto-detected ${r.added.length} app\\(s\\): ${names}`;
  }
  const apps = loadApps();
  const target = apps.find((a) => a.name === appArg);
  if (!target) return `App not found: \`${escapeMarkdownV2(appArg)}\``;
  const summary = await scanAppWithClaude(target.path);
  if (!summary) {
    return `Scan failed for \`${escapeMarkdownV2(appArg)}\` \\(see server logs\\)`;
  }
  updateAppDescription(appArg, summary);
  return `✨ Updated \`${escapeMarkdownV2(appArg)}\`: ${escapeMarkdownV2(truncate(summary, 200))}`;
}

function renderRuns(idArg: string | undefined): string {
  if (!idArg) return "Usage: `/runs t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const meta = readMeta(join(SESSIONS_DIR, idArg));
  if (!meta) return `Task not found: \`${idArg}\``;
  if (meta.runs.length === 0) return `No runs yet for \`${idArg}\``;
  const rows: string[] = [];
  for (const r of meta.runs) {
    const icon =
      r.status === "running" ? "🟢" :
      r.status === "done"    ? "✅" :
      r.status === "failed"  ? "⚠️" :
      r.status === "queued"  ? "⏳" : "💤";
    const role = escapeMarkdownV2(r.role);
    const repo = escapeMarkdownV2(r.repo);
    rows.push(`${icon} ${role} @ ${repo} \\(\`${r.sessionId.slice(0, 8)}\`\\)`);
  }
  const lines: string[] = [
    `*${meta.runs.length} run\\(s\\) for \`${idArg}\`:*`,
    "",
    ...capListLines(rows, LIST_CAP),
  ];
  return lines.join("\n");
}

function renderPending(): string {
  const pending = listAllPending();
  if (pending.length === 0) return "🟢 No pending permissions";
  const rows: string[] = [];
  for (const p of pending) {
    const tool = escapeMarkdownV2(p.tool);
    rows.push(
      `🔐 \`${tool}\` · session \`${p.sessionId.slice(0, 8)}\` · req \`${p.requestId.slice(0, 8)}\``,
    );
  }
  const lines: string[] = [
    `*${pending.length} pending:*`,
    "",
    ...capListLines(rows, LIST_CAP),
    "",
    "Reply with `/allow <reqId>` or `/deny <reqId>` \\(8\\-char prefix is enough\\)\\.",
  ];
  return lines.join("\n");
}

function renderPendingLogins(): string {
  const pending = listPendingLogins();
  if (pending.length === 0) return "🟢 No pending device logins";
  const rows: string[] = [];
  for (const p of pending) {
    const ua = escapeMarkdownV2(truncate(p.userAgent, 60));
    const ip = escapeMarkdownV2(p.remoteIp);
    const ageSec = Math.max(0, Math.round((Date.now() - Date.parse(p.createdAt)) / 1000));
    rows.push(
      `🔐 \`${p.id.slice(0, 8)}\` · ${ua} from \`${ip}\` · ${ageSec}s ago`,
    );
  }
  const lines: string[] = [
    `*${pending.length} pending device login\\(s\\):*`,
    "",
    ...capListLines(rows, LIST_CAP),
    "",
    "Reply with `/approvelogin <id>` or `/denylogin <id>` \\(8\\-char prefix is enough\\)\\.",
  ];
  return lines.join("\n");
}


function telegramConfig(): { token: string; chatId: string } | null {
  const s = getManifestTelegramSettings();
  if (!s.botToken || !s.chatId) return null;
  return { token: s.botToken, chatId: s.chatId };
}

export async function sendReply(
  cfg: { token: string; chatId: string },
  text: string,
  replyTo?: number,
): Promise<void> {
  const url = `${TG_HOST}/bot${encodeURIComponent(cfg.token)}/sendMessage`;
  await sendTelegramApiMessage(
    url,
    (plainFallbackUsed) => {
      const body: Record<string, unknown> = {
        chat_id: cfg.chatId,
        text,
        ...(plainFallbackUsed ? {} : { parse_mode: "HTML" }),
        disable_web_page_preview: true,
      };
      if (replyTo) body.reply_to_message_id = replyTo;
      return body;
    },
    "telegram-cmd",
  );
}

async function publishCommandsToBotFather(token: string): Promise<void> {
  const commands = COMMANDS.map((c) => ({
    command: c.name,
    description: truncate(c.description, 256),
  }));
  const url = `${TG_HOST}/bot${encodeURIComponent(token)}/setMyCommands`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    throw new Error(`setMyCommands HTTP ${r.status}`);
  }
}


function sectionIcon(section: TaskSection): string {
  switch (section) {
    case SECTION_TODO: return "⚪";
    case SECTION_DOING: return "🟡";
    case SECTION_BLOCKED: return "🔴";
    case SECTION_DONE: return "✅";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mdLiteToHtml(input: string): string {
  const stripped = input.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");

  const out: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === "`") {
      const close = stripped.indexOf("`", i + 1);
      if (close === -1) {
        out.push(escapeHtml("`"));
        i += 1;
        continue;
      }
      const inner = stripped.slice(i + 1, close);
      out.push(`<code>${escapeHtml(inner)}</code>`);
      i = close + 1;
      continue;
    }
    if (ch === "*") {
      const close = stripped.indexOf("*", i + 1);
      if (close === -1) {
        out.push(escapeHtml("*"));
        i += 1;
        continue;
      }
      const inner = stripped.slice(i + 1, close);
      if (inner.length === 0) {
        out.push(escapeHtml("**"));
        i = close + 1;
        continue;
      }
      out.push(`<b>${escapeHtml(inner)}</b>`);
      i = close + 1;
      continue;
    }
    let j = i + 1;
    while (j < stripped.length && stripped[j] !== "`" && stripped[j] !== "*") {
      j += 1;
    }
    out.push(escapeHtml(stripped.slice(i, j)));
    i = j;
  }
  return out.join("");
}

const TELEGRAM_TEXT_LIMIT = 4096;

function convertReplyChunk(raw: string, cutLen: number): string {
  const wasCut = cutLen < raw.length;
  return mdLiteToHtml(raw.slice(0, cutLen) + (wasCut ? "…" : ""));
}

export function buildReplyBody(raw: string): string {
  let cutLen = Math.min(raw.length, REPLY_MAX);
  let html = convertReplyChunk(raw, cutLen);
  while (html.length > TELEGRAM_TEXT_LIMIT && cutLen > 0) {
    cutLen = Math.floor(cutLen * 0.9);
    html = convertReplyChunk(raw, cutLen);
  }
  return html;
}

const escapeMarkdownV2 = escapeHtml;

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}


interface UserListenerState {
  unsubscribe: (() => void) | null;
}
const userListener: UserListenerState = (() => {
  const G = globalThis as unknown as {
    __bridgeTelegramUserListener?: UserListenerState;
  };
  G.__bridgeTelegramUserListener ??= { unsubscribe: null };
  return G.__bridgeTelegramUserListener;
})();

async function shouldDispatchUserMessage(msg: InboundMessage): Promise<boolean> {
  if (!msg.text.trim()) return false;
  if (!msg.isPrivate) return false;
  const target = (await import("./apps")).getManifestTelegramSettings().user.targetChatId;
  if (!/^-?\d+$/.test(target)) return false;
  return msg.senderId === target || msg.chatId === target;
}

export async function startTelegramUserCommandListener(): Promise<void> {
  if (userListener.unsubscribe) return;
  if (!isUserClientConfigured()) return;

  userListener.unsubscribe = await subscribeUserMessages(async (msg) => {
    if (!(await shouldDispatchUserMessage(msg))) return;
    let reply: string;
    try {
      reply = await smartDispatch(msg.text);
    } catch (err) {
      reply = `Error: ${(err as Error).message}`;
    }
    try {
      await sendUserMessage(buildReplyBody(reply), {
        target: msg.chatId,
        parseMode: "html",
      });
    } catch (err) {
      logWarn(
        "telegram-user-cmd",
        "reply failed",
        { error: (err as Error).message },
      );
    }
  });
  logInfo("telegram-user-cmd", "inbound listener installed");
}

export async function stopTelegramUserCommandListener(): Promise<void> {
  const fn = userListener.unsubscribe;
  userListener.unsubscribe = null;
  if (fn) {
    try { fn(); } catch { }
  }
}
