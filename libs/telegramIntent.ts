
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { treeKill } from "./processKill";
import { BRIDGE_ROOT } from "./paths";
import { listTasks } from "./tasksStore";
import type { Task } from "./tasks";
import { COMMANDS, type CommandDef } from "./telegramCommands";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const ROUTE_TIMEOUT_MS = 45_000;
const STDOUT_CAP_BYTES = 32 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
const MAX_TASKS_IN_PROMPT = 30;

export interface IntentResult {
  command: string | null;
  reply: string;
  confidence: "high" | "medium" | "low";
}

export async function routeNaturalLanguage(
  text: string,
): Promise<IntentResult | null> {
  if (!existsSync(BRIDGE_ROOT)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return null;

  const prompt = buildPrompt(trimmed);
  const raw = await runClaude(prompt);
  if (!raw) return null;

  return parseResponse(raw);
}

function buildPrompt(userText: string): string {
  const tasks = listTasks().slice(0, MAX_TASKS_IN_PROMPT);
  const lines: string[] = [];

  lines.push(
    "You are a routing helper for the Claude Bridge Telegram bot.",
    "Read the user's chat message and decide whether it maps to one of",
    "the bridge's slash commands listed below.",
    "",
    "## Bridge commands",
    "",
  );
  for (const c of COMMANDS) {
    lines.push(`- \`/${c.name}\` — ${c.description}`);
  }

  lines.push("", "## Recent tasks (most recent first)", "");
  if (tasks.length === 0) {
    lines.push("(no tasks yet)");
  } else {
    for (const t of tasks) {
      const app = t.app ? ` · app=${t.app}` : "";
      const title = t.title.length > 80 ? t.title.slice(0, 80) + "…" : t.title;
      lines.push(`- \`${t.id}\` — ${t.section}${app} — ${title}`);
    }
  }

  lines.push(
    "",
    "## User message",
    "",
    "```",
    userText,
    "```",
    "",
    "## Output contract",
    "",
    "Respond with ONE fenced JSON code block — nothing before, nothing after:",
    "",
    "```json",
    "{",
    '  "command": "/<name> <args>" OR null,',
    '  "reply": "<short natural-language wrapper, in the user\'s language>",',
    '  "confidence": "high" | "medium" | "low"',
    "}",
    "```",
    "",
    "Rules:",
    "- `command` MUST be one of the slash commands above with literal task ids resolved from the recent task list. Do NOT invent task ids.",
    "- When the user references a task by description (\"task review code\", \"the LMS one\", \"task vừa rồi\"), resolve to the matching `t_…` id from the list. If multiple match, set `command` to `null` and ask for clarification in `reply` listing the candidates.",
    "- Mirror the user's language in `reply` (Vietnamese / English / etc.).",
    "- For chit-chat or questions, set `command` to `null` and answer in `reply`.",
    "- Confidence `high` = clear single match. `medium` = best guess but ambiguous. `low` = no command — `command` MUST be null.",
    "- Do NOT include any prose outside the JSON block.",
  );

  return lines.join("\n");
}

function runClaude(prompt: string): Promise<string | null> {
  return new Promise<string | null>((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      CLAUDE_BIN,
      ["-p", "--permission-mode", "bypassPermissions", prompt],
      {
        cwd: BRIDGE_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(value);
    };

    const timer = setTimeout(() => {
      treeKill(child, "SIGTERM");
      setTimeout(() => treeKill(child, "SIGKILL"), 3_000);
      console.warn(`[telegram-intent] timed out after ${ROUTE_TIMEOUT_MS}ms`);
      settle(null);
    }, ROUTE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_CAP_BYTES) {
        stdout = stdout.slice(-STDOUT_CAP_BYTES);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_CAP_BYTES) {
        stderr = stderr.slice(-STDERR_CAP_BYTES);
      }
    });

    child.on("error", (err) => {
      console.warn(`[telegram-intent] spawn error:`, err.message);
      settle(null);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        console.warn(`[telegram-intent] claude exited ${code}: ${tail}`);
        settle(null);
        return;
      }
      settle(stdout);
    });
  });
}

function parseResponse(raw: string): IntentResult | null {
  const json = extractJsonBlock(raw);
  if (!json) {
    console.warn("[telegram-intent] no JSON block in response");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn(
      "[telegram-intent] JSON parse failed:",
      (err as Error).message,
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const cmdRaw = obj.command;
  let command: string | null = null;
  if (typeof cmdRaw === "string" && cmdRaw.trim().startsWith("/")) {
    command = cmdRaw.trim();
    if (!isKnownCommand(command)) {
      console.warn(
        `[telegram-intent] LLM returned unknown command, dropping: ${command}`,
      );
      command = null;
    }
  }

  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  const confidenceRaw =
    typeof obj.confidence === "string"
      ? obj.confidence.trim().toLowerCase()
      : "";
  const confidence: IntentResult["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
      ? confidenceRaw
      : command
        ? "medium"
        : "low";

  if (confidence === "low" && command) {
    return { command: null, reply, confidence: "low" };
  }
  return { command, reply, confidence };
}

function extractJsonBlock(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

const COMMAND_NAMES: Set<string> = (() => {
  const names = new Set<string>();
  for (const c of COMMANDS as CommandDef[]) names.add(c.name.toLowerCase());
  return names;
})();

function isKnownCommand(text: string): boolean {
  const head = text.replace(/^\//, "").split(/[\s@]/)[0];
  return COMMAND_NAMES.has(head.toLowerCase());
}

export type { Task };
