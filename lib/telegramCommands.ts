/**
 * Telegram bot command handler.
 *
 * Pairs with `lib/telegramNotifier.ts` (outbound side). This file is
 * the inbound side: long-poll `getUpdates`, parse slash commands, run
 * the matching bridge action, and reply.
 *
 * Why long-polling and not webhook?
 *   - The bridge runs on `localhost:7777`. A webhook needs a public
 *     URL (ngrok / port forward), which is friction for a local tool.
 *   - Long-polling is one outbound HTTPS call every ~25s — cheap, no
 *     inbound network rules required.
 *
 * Security:
 *   - Only messages from the configured `chatId` are processed —
 *     strangers can't operate the bridge by spamming the bot.
 *   - All side-effecting commands log the operator's chatId + the run
 *     they touched, so a leaked token is at least auditable.
 *
 * The command surface is intentionally minimal — Telegram is a triage
 * UI, not a full IDE. The web UI at `/tasks` remains the primary
 * surface; commands here are quick taps when you're away from the
 * machine.
 */

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
import { readMeta, applyManyRuns } from "./meta";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { spawnCoordinatorForTask } from "./coordinator";
import { resumeClaude } from "./spawn";
import { killChild } from "./spawnRegistry";
import { autoDetectApps, loadApps } from "./apps";
import { isValidTaskId, type TaskSection } from "./tasks";
import { getManifestTelegramSettings } from "./apps";
import {
  answer as answerPermission,
  listAllPending,
  type PendingRequest,
} from "./permissionStore";
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

const TG_HOST = "https://api.telegram.org";
const POLL_TIMEOUT_S = 25; // long-poll seconds (Telegram caps at 50)
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

/**
 * Start the long-poll loop. Idempotent — safe to call after a
 * settings change (already-running loops will be aborted + restarted
 * inside `stopTelegramCommandPoller`).
 *
 * Fire-and-forget: the loop runs until `stopTelegramCommandPoller`
 * aborts it. Errors are caught at the top level so a transient
 * Telegram outage doesn't bubble up and crash the Next.js dev server.
 */
export function startTelegramCommandPoller(): void {
  if (poller.running) return;
  const cfg = telegramConfig();
  if (!cfg) return;
  poller.running = true;
  poller.abort = new AbortController();
  void publishCommandsToBotFather(cfg.token).catch((err) => {
    console.warn("[telegram-cmd] setMyCommands failed:", (err as Error).message);
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
    // Re-read config each iteration so credential changes take effect
    // without a server restart. If creds disappear mid-loop we exit.
    const live = telegramConfig();
    if (!live) {
      poller.running = false;
      break;
    }
    cfg = live;

    try {
      const updates = await fetchUpdates(cfg.token, poller.offset);
      for (const up of updates) {
        // Advance offset before handling so a thrown handler can't
        // re-fire the same update on the next loop.
        if (up.update_id >= poller.offset) {
          poller.offset = up.update_id + 1;
        }
        try {
          await handleUpdate(up, cfg);
        } catch (err) {
          console.warn(`[telegram-cmd] handler crashed:`, (err as Error).message);
        }
      }
    } catch (err) {
      if (!poller.running) break;
      const msg = (err as Error).message;
      // Aborted on shutdown is expected — silent. Other errors get
      // logged + a back-off so we don't hammer Telegram on outages.
      if (!/abort/i.test(msg)) {
        console.warn(`[telegram-cmd] poll error:`, msg);
        await delay(POLL_RESTART_DELAY_MS);
      }
    }
  }
}

async function fetchUpdates(
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
    signal: poller.abort?.signal,
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
  // Whitelist by chat id — only the configured chat can run commands.
  if (String(msg.chat.id) !== cfg.chatId) {
    console.warn(
      `[telegram-cmd] ignoring message from non-allowlisted chat ${msg.chat.id}`,
    );
    return;
  }
  const text = msg.text.trim();
  if (!text) return;

  // smartDispatch handles BOTH slash commands AND free-form NL —
  // routing the latter through the `lib/telegramIntent` LLM.
  const reply = await smartDispatch(text);
  if (reply) await sendReply(cfg, mdLiteToHtml(reply), msg.message_id);
}

export interface CommandDef {
  /** Without leading slash. */
  name: string;
  /** Short hint shown by Telegram's autocomplete. */
  description: string;
  /**
   * Args after the command. `rawTail` is the verbatim text after the
   * command name (whitespace-trimmed), for handlers like `/new` that
   * need the full body unmodified. `args` is `rawTail` split on
   * whitespace.
   */
  handler(args: string[], rawTail: string): Promise<string>;
}

export const COMMANDS: CommandDef[] = [
  // ─── Read-only ─────────────────────────────────────────────────────
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
    handler: async () => renderTasks(["DONE — not yet archived"]),
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
  // ─── Task lifecycle ────────────────────────────────────────────────
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
  // ─── Permissions ───────────────────────────────────────────────────
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
  // ─── Apps ──────────────────────────────────────────────────────────
  {
    name: "scan",
    description: "Auto-detect siblings, or rescan an app's description — usage: /scan [app]",
    handler: async (args) => commandScan(args[0]),
  },
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c] as const));

/**
 * Smart dispatcher — accepts EITHER a slash command OR free-form
 * natural-language text. Slash commands go straight to the pure
 * dispatcher; free-form text is routed through the LLM middleware
 * (`lib/telegramIntent`) to pick a command + craft a wrapper reply.
 *
 * The bot path and the user-client inbound path both use this so the
 * NL behavior is consistent across channels.
 *
 * Returns either:
 *   - The dispatcher's raw output (slash path)
 *   - LLM's reply alone (no command picked)
 *   - LLM's reply + a `\n\n` + dispatcher output (command picked)
 *   - A "didn't understand" fallback when LLM call fails entirely
 */
export async function smartDispatch(rawText: string): Promise<string> {
  const trimmed = rawText.trim();
  if (!trimmed) return "Empty message — send /help for the command list.";
  if (trimmed.startsWith("/")) {
    return dispatchCommand(trimmed);
  }
  // Lazy import to avoid pulling the LLM module + its child_process
  // wiring into module-init when callers only ever use slash commands.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { routeNaturalLanguage } = require("./telegramIntent") as typeof import("./telegramIntent");
  let result;
  try {
    result = await routeNaturalLanguage(trimmed);
  } catch (err) {
    console.warn("[telegram-cmd] intent router crashed:", (err as Error).message);
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
    // No action picked — relay the LLM's standalone reply.
    return reply || "Send /help to see what I can do.";
  }

  // Action picked → run it. Concatenate the LLM's wrapper + dispatch
  // output so the operator sees both the explanation and the result.
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

/**
 * Pure slash-command dispatcher — exported for tests. Splits the raw
 * text into command name + args + rawTail, looks up the handler,
 * returns the reply (or "unknown command" when nothing matches).
 */
export async function dispatchCommand(rawText: string): Promise<string> {
  // Telegram supports `/cmd@botname` — strip the @suffix so a bot in a
  // group with multiple bots still matches its own commands.
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

// ─── Renderers ────────────────────────────────────────────────────────

function renderHelp(): string {
  const lines = ["*Bridge commands:*", ""];
  for (const c of COMMANDS) {
    lines.push(`/${c.name} — ${c.description}`);
  }
  return lines.join("\n");
}

function renderTasks(sections: TaskSection[]): string {
  const all = listTasks();
  const filtered = all
    .filter((t) => sections.includes(t.section))
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  if (filtered.length === 0) {
    return `(no tasks in ${sections.join(" / ")})`;
  }
  const lines: string[] = [`*${filtered.length} task(s):*`, ""];
  for (const t of filtered) {
    const icon = sectionIcon(t.section);
    const app = t.app ? ` · \`${t.app}\`` : "";
    const titleEsc = escapeMarkdownV2(truncate(t.title, 80));
    lines.push(`${icon} \`${t.id}\`${escapeMarkdownV2(app)} — ${titleEsc}`);
  }
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
  const lines: string[] = [`*${active.length} active session(s):*`, ""];
  for (const r of active) {
    const role = escapeMarkdownV2(r.role);
    const repo = escapeMarkdownV2(r.repo);
    lines.push(
      `🟢 \`${r.taskId}\` — ${role} @ ${repo} \\(${r.sessionId.slice(0, 8)}\\)`,
    );
  }
  return lines.join("\n");
}

function renderApps(): string {
  const apps = loadApps();
  if (apps.length === 0) return "(no apps registered)";
  const all = listTasks();
  const lines: string[] = [`*${apps.length} app(s):*`, ""];
  for (const a of apps) {
    const own = all.filter((t) => t.app === a.name);
    const doing = own.filter((t) => t.section === "DOING").length;
    const todo = own.filter((t) => t.section === "TODO").length;
    const blocked = own.filter((t) => t.section === "BLOCKED").length;
    lines.push(
      `📦 \`${escapeMarkdownV2(a.name)}\` — ${doing} doing · ${todo} todo · ${blocked} blocked`,
    );
  }
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

// ─── Side-effecting commands ──────────────────────────────────────────

async function commandDone(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/done t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const t = await updateTask(idArg, {
    section: "DONE — not yet archived",
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
  // Also flip the meta rows so the UI doesn't keep showing them as
  // running while the OS-level kill propagates.
  await applyManyRuns(
    join(SESSIONS_DIR, idArg),
    running.map((r) => ({
      sessionId: r.sessionId,
      patch: { status: "failed", endedAt: new Date().toISOString() },
    })),
  );
  return `🛑 Killed ${killed} of ${running.length} session\\(s\\) for \`${idArg}\``;
}

async function commandDelete(idArg: string | undefined): Promise<string> {
  if (!idArg) return "Usage: `/delete t_YYYYMMDD_NNN`";
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const r = deleteTask(idArg);
  if (!r.ok) return `Task not found: \`${idArg}\``;
  return `🗑 Deleted \`${idArg}\` \\(${r.sessionsDeleted} session file\\(s\\) removed\\)`;
}

async function commandNew(rawTail: string): Promise<string> {
  const trimmed = rawTail.trim();
  if (!trimmed) return "Usage: `/new <description>` \\(first line becomes the title\\)";
  // Mirror app/api/tasks/route.ts: derive a one-line title from the
  // first non-empty line, then create the task and (concurrently) run
  // heuristic detection + spawn the coordinator.
  const firstLine = trimmed.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const title = firstLine
    ? (firstLine.length > 100 ? firstLine.slice(0, 100).trimEnd() + "…" : firstLine)
    : "(untitled)";
  const task = createTask({ title, body: trimmed, app: null });

  // Detection: heuristic now, persist, then fire-and-forget LLM upgrade
  // when the configured mode includes it. Same flow tasks/route.ts uses.
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
          console.warn("[telegram-cmd] /new LLM upgrade failed:", err);
        }
      })();
    }
  } catch (err) {
    console.warn("[telegram-cmd] /new detection failed (non-fatal):", err);
  }

  // Spawn coordinator. Don't await — return the task id immediately so
  // the user gets the confirmation fast; the spawn lifecycle hooks
  // post follow-up notifications.
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
    // Mirror app/api/tasks/<id>/continue logic.
    const message =
      `Continue from where you left off for bridge task ${idArg}. Read sessions/${idArg}/meta.json to see which child agents are still 'running', which 'done', and which 'failed'. If all children are done, finalize per coordinator.md §5. Otherwise re-orchestrate as needed.`;
    resumeClaude(BRIDGE_ROOT, coord.sessionId, message, { mode: "bypassPermissions" });
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
  // /clear keeps the run history (matches app/api/tasks/<id>/clear) and
  // forcibly spawns a fresh coordinator.
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
  // Telegram has no markdown bullet/heading → escape and rely on plain
  // monospace blocks for code regions. Cap so a runaway summary doesn't
  // blow past the 4096-char Telegram message limit.
  return [
    `*Summary \\(\`${idArg}\`\\):*`,
    "",
    "```",
    truncate(text, 2800),
    "```",
  ].join("\n");
}

async function commandReport(
  idArg: string | undefined,
  roleArg: string | undefined,
): Promise<string> {
  if (!idArg || !roleArg) {
    return "Usage: `/report t_YYYYMMDD_NNN <role>` \\(role like `coder`, `reviewer`\\)";
  }
  if (!isValidTaskId(idArg)) return `Invalid task id: \`${idArg}\``;
  const dir = join(SESSIONS_DIR, idArg, "reports");
  if (!existsSync(dir)) return `No reports dir for \`${idArg}\``;
  // Reports are named `<role>-<repo>.md`. Match by role prefix to save
  // the user typing the repo too.
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

/**
 * `/allow <reqId>` / `/deny <reqId>`. The user copy-pastes the
 * `requestId` from the most recent 🔐 ping. We accept either a full
 * UUID or a short prefix (≥6 chars) and look it up across all pending
 * requests — `requestId` is unique by itself, so no `sessionId` arg
 * needed.
 */
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

async function commandScan(appArg: string | undefined): Promise<string> {
  // No arg → auto-detect siblings of the bridge folder.
  if (!appArg) {
    const r = await autoDetectApps();
    if (r.added.length === 0) {
      return `🔎 No new apps detected \\(${r.skipped.length} skipped\\)`;
    }
    const names = r.added.map((a) => `\`${escapeMarkdownV2(a.name)}\``).join(", ");
    return `📦 Auto-detected ${r.added.length} app\\(s\\): ${names}`;
  }
  // With an arg → re-scan that app's description with claude.
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
  const lines: string[] = [`*${meta.runs.length} run\\(s\\) for \`${idArg}\`:*`, ""];
  for (const r of meta.runs) {
    const icon =
      r.status === "running" ? "🟢" :
      r.status === "done"    ? "✅" :
      r.status === "failed"  ? "⚠️" :
      r.status === "queued"  ? "⏳" : "💤";
    const role = escapeMarkdownV2(r.role);
    const repo = escapeMarkdownV2(r.repo);
    lines.push(`${icon} ${role} @ ${repo} \\(\`${r.sessionId.slice(0, 8)}\`\\)`);
  }
  return lines.join("\n");
}

function renderPending(): string {
  const pending = listAllPending();
  if (pending.length === 0) return "🟢 No pending permissions";
  const lines: string[] = [`*${pending.length} pending:*`, ""];
  for (const p of pending) {
    const tool = escapeMarkdownV2(p.tool);
    lines.push(
      `🔐 \`${tool}\` · session \`${p.sessionId.slice(0, 8)}\` · req \`${p.requestId.slice(0, 8)}\``,
    );
  }
  lines.push("", "Reply with `/allow <reqId>` or `/deny <reqId>` \\(8\\-char prefix is enough\\)\\.");
  return lines.join("\n");
}

// ─── Telegram helpers ─────────────────────────────────────────────────

function telegramConfig(): { token: string; chatId: string } | null {
  const s = getManifestTelegramSettings();
  if (!s.botToken || !s.chatId) return null;
  return { token: s.botToken, chatId: s.chatId };
}

async function sendReply(
  cfg: { token: string; chatId: string },
  text: string,
  replyTo?: number,
): Promise<void> {
  const url = `${TG_HOST}/bot${encodeURIComponent(cfg.token)}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: cfg.chatId,
    text: text.length > REPLY_MAX ? text.slice(0, REPLY_MAX) + "…" : text,
    // HTML mode has only THREE reserved chars (`<`, `>`, `&`) vs
    // MarkdownV2's nineteen. Renderers below emit `<b>` / `<code>` /
    // `<pre>` directly and escape user-supplied content via
    // `escapeHtml`. Far harder to break than the MD escape
    // ratchet — the original implementation kept hitting 400 on
    // unescaped parentheses inside command descriptions.
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyTo) body.reply_to_message_id = replyTo;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const desc = await r.text().catch(() => "");
      console.warn(
        `[telegram-cmd] sendMessage ${r.status}: ${desc.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[telegram-cmd] sendMessage error:`, (err as Error).message);
  }
}

/**
 * Tell BotFather what commands this bot exposes so Telegram's "/" UI
 * shows autocomplete + descriptions. Idempotent — safe to call on
 * every poller start; the API just overwrites the previous list.
 */
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

// ─── Misc utilities ──────────────────────────────────────────────────

function sectionIcon(section: TaskSection): string {
  switch (section) {
    case "TODO": return "⚪";
    case "DOING": return "🟡";
    case "BLOCKED": return "🔴";
    case "DONE — not yet archived": return "✅";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Escape user-supplied content for Telegram HTML mode. Only `<`, `>`,
 * and `&` are reserved — everything else passes through verbatim. Far
 * less error-prone than MarkdownV2's 19-char ratchet.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The renderers in this file were originally written against
 * MarkdownV2 (`*bold*`, `` `code` ``, `\(`, `\.`, `\!` …). Telegram
 * keeps tightening MarkdownV2's reserved-char list and we kept hitting
 * `Bad Request: Character '(' is reserved …` from the API.
 *
 * Rather than audit every template literal, we converted the BOT's
 * `parse_mode` to HTML and run all rendered output through this
 * shim. It:
 *   1. Strips the leftover MarkdownV2 escape backslashes (`\(` → `(`)
 *      so the parens / dots / etc. show up as plain text.
 *   2. Tokenizes into backtick + asterisk + plain runs.
 *   3. Emits `<code>…</code>` and `<b>…</b>` with the inner text
 *      HTML-escaped, plus HTML-escapes the plain runs.
 *
 * Pure function. Safe for `escapeMarkdownV2`-prefixed content — the
 * old escaper added `\\` before reserved chars, which step 1 strips
 * before HTML-escaping the result.
 */
function mdLiteToHtml(input: string): string {
  // Step 1 — drop leftover MarkdownV2 escape backslashes. The legacy
  // `escapeMarkdownV2` (now an alias of `escapeHtml`) used to insert
  // these; older render code still emits literal `\(`, `\)`, `\.`,
  // etc. They become plain chars in HTML mode.
  const stripped = input.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");

  // Step 2 — tokenize. We walk char-by-char and respect backtick
  // boundaries strictly (no nesting), then handle `*…*` only inside
  // plain segments. Backticks have higher precedence — `*foo*` inside
  // `` `code *with stars* ` `` stays literal inside <code>.
  const out: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === "`") {
      // Find matching closing backtick on the same logical run.
      const close = stripped.indexOf("`", i + 1);
      if (close === -1) {
        // Unbalanced — emit the lone backtick as plain text.
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
      // Avoid empty `**` collapsing into <b></b>.
      if (inner.length === 0) {
        out.push(escapeHtml("**"));
        i = close + 1;
        continue;
      }
      out.push(`<b>${escapeHtml(inner)}</b>`);
      i = close + 1;
      continue;
    }
    // Plain run — read until next `*` or `` ` `` and HTML-escape it.
    let j = i + 1;
    while (j < stripped.length && stripped[j] !== "`" && stripped[j] !== "*") {
      j += 1;
    }
    out.push(escapeHtml(stripped.slice(i, j)));
    i = j;
  }
  return out.join("");
}

/** @deprecated alias — see escapeHtml. Kept so existing call sites compile. */
const escapeMarkdownV2 = escapeHtml;

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Inbound via user-client (gram-js) ─────────────────────────────────

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

/**
 * Allowlist for user-client inbound: only messages FROM the operator's
 * own user account are dispatched as commands. We don't want a random
 * person who DMs the operator's bot to be able to run `/delete` on the
 * bridge. The check uses `isPrivate` + `senderId === selfId`.
 *
 * `selfId` is read from the configured `targetChatId` when it's a
 * numeric user id; otherwise we fall back to "any private chat" — the
 * operator can override this by editing `targetChatId` to their own
 * user id (visible in `/api/telegram/user/test`'s `me.id` response).
 */
async function shouldDispatchUserMessage(msg: InboundMessage): Promise<boolean> {
  // We accept BOTH slash commands AND free-form natural-language text
  // (the latter goes through `lib/telegramIntent` for LLM routing).
  // Filter only on the channel-level constraints below.
  if (!msg.text.trim()) return false;
  // Only private chats (1-on-1 with the operator). Group / channel
  // messages are ignored — too easy to accidentally trigger a command
  // by typing `/help` (or just chatting) in an unrelated group.
  if (!msg.isPrivate) return false;
  const target = (await import("./apps")).getManifestTelegramSettings().user.targetChatId;
  // Hard requirement: a numeric chat id must be configured before the
  // user-client listener will dispatch any command. Without it we have
  // no way to verify the sender is the operator — anyone who DMs the
  // operator's Telegram account would otherwise be able to run
  // `/delete`, `/kill`, `/new`, etc.
  if (!/^-?\d+$/.test(target)) return false;
  return msg.senderId === target || msg.chatId === target;
}

/**
 * Start the user-client inbound listener. Idempotent — if already
 * subscribed, the second call is a no-op. Safe to call before the
 * client is connected; gram-js queues the handler attach.
 */
export async function startTelegramUserCommandListener(): Promise<void> {
  if (userListener.unsubscribe) return;
  if (!isUserClientConfigured()) return;

  userListener.unsubscribe = await subscribeUserMessages(async (msg) => {
    if (!(await shouldDispatchUserMessage(msg))) return;
    let reply: string;
    try {
      // smartDispatch routes both slash commands AND natural-language
      // text — same UX as the bot path.
      reply = await smartDispatch(msg.text);
    } catch (err) {
      reply = `Error: ${(err as Error).message}`;
    }
    // Match the bot path: convert MarkdownV2-style render output to
    // HTML before posting. gram-js's `parseMode: "html"` parses the
    // resulting `<b>` / `<code>` tags into Telegram's native bold +
    // monospace, so the operator sees the same formatting whether
    // they DM the bot or DM their own user account.
    try {
      await sendUserMessage(mdLiteToHtml(reply), {
        target: msg.chatId,
        parseMode: "html",
      });
    } catch (err) {
      console.warn(
        `[telegram-user-cmd] reply failed:`,
        (err as Error).message,
      );
    }
  });
  console.info("[telegram-user-cmd] inbound listener installed");
}

export async function stopTelegramUserCommandListener(): Promise<void> {
  const fn = userListener.unsubscribe;
  userListener.unsubscribe = null;
  if (fn) {
    try { fn(); } catch { /* ignore */ }
  }
}
