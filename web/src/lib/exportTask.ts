import type { Meta, Task } from "@/api/types";

/**
 * Render a task + its meta as a single Markdown document the user can
 * paste into a doc, attach to a ticket, or hand off to another tool.
 * Run history is summarized; the per-message conversation export lives
 * in `exportSessionMarkdown`.
 */
export function exportTaskMarkdown(task: Task, meta: Meta | null): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push("");
  lines.push(`- **ID:** \`${task.id}\``);
  lines.push(`- **Section:** ${task.section}`);
  lines.push(`- **Status:** ${task.status}${task.checked ? " · ✅ completed" : ""}`);
  if (task.app) lines.push(`- **App:** \`${task.app}\``);
  if (meta?.createdAt) lines.push(`- **Created:** ${meta.createdAt}`);
  lines.push("");

  if (task.body && task.body.trim() !== task.title.trim()) {
    lines.push("## Brief");
    lines.push("");
    lines.push(task.body.trim());
    lines.push("");
  }

  const runs = meta?.runs ?? [];
  if (runs.length > 0) {
    lines.push(`## Agent runs (${runs.length})`);
    lines.push("");
    for (const r of runs) {
      const dur = r.startedAt && r.endedAt
        ? `${Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)}s`
        : "—";
      lines.push(
        `- \`${r.role}\` @ \`${r.repo}\` — ${r.status} (${dur}) · session \`${r.sessionId.slice(0, 8)}…\``,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render a Claude `.jsonl`-style log as Markdown — user/assistant turns
 * inlined, tool calls collapsed to one-line summaries, system noise
 * dropped. Suitable for sharing or attaching to a PR.
 */
interface MinimalEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
    }>;
  };
}

const SYSTEM_TAG_RE =
  /<\/?(system-reminder|task-notification|ide_opened_file|ide_selection|command-message|local-command-stdout)[^>]*>/gi;

function strip(s: string): string {
  return s.replace(SYSTEM_TAG_RE, "").trim();
}

function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b && typeof b === "object" && typeof (b as { text?: string }).text === "string" ? (b as { text: string }).text : "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function exportSessionMarkdown(
  entries: MinimalEntry[],
  opts?: { title?: string; sessionId?: string; repo?: string; role?: string },
): string {
  const lines: string[] = [];
  lines.push(`# ${opts?.title ?? "Session"}`);
  if (opts?.sessionId) lines.push(`*session* \`${opts.sessionId}\`${opts.repo ? ` · *repo* \`${opts.repo}\`` : ""}${opts.role ? ` · *role* \`${opts.role}\`` : ""}`);
  lines.push("");

  for (const e of entries) {
    const c = e.message?.content;
    if (!c) continue;
    const blocks = typeof c === "string" ? [{ type: "text", text: c }] : c;
    if (e.type === "user") {
      const isToolResult = blocks.some((b) => b?.type === "tool_result");
      if (isToolResult) {
        for (const b of blocks) {
          if (b?.type !== "tool_result") continue;
          const body = strip(stringifyResult(b.content));
          if (!body) continue;
          lines.push(`> *tool result*${b.is_error ? " ⚠ error" : ""}`);
          for (const ln of body.split("\n").slice(0, 30)) lines.push(`> ${ln}`);
          if (body.split("\n").length > 30) lines.push(`> …(truncated)`);
          lines.push("");
        }
      } else {
        const text = strip(blocks.filter((b) => b?.type === "text").map((b) => b!.text ?? "").join("\n"));
        if (text) {
          lines.push(`### 🧑 You${e.timestamp ? ` *${e.timestamp}*` : ""}`);
          lines.push("");
          lines.push(text);
          lines.push("");
        }
      }
    } else if (e.type === "assistant") {
      lines.push(`### 🤖 Assistant${e.timestamp ? ` *${e.timestamp}*` : ""}`);
      lines.push("");
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          lines.push(b.text.trim());
          lines.push("");
        } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          lines.push("<details><summary>thought</summary>");
          lines.push("");
          lines.push("```");
          lines.push(b.thinking.trim());
          lines.push("```");
          lines.push("");
          lines.push("</details>");
          lines.push("");
        } else if (b?.type === "tool_use") {
          const inputJson = (() => {
            try { return JSON.stringify(b.input ?? {}, null, 2); }
            catch { return String(b.input); }
          })();
          lines.push(`**\`${b.name ?? "tool"}\`**`);
          lines.push("");
          lines.push("```json");
          lines.push(inputJson);
          lines.push("```");
          lines.push("");
        }
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Trigger a browser download of `text` as `<filename>` with the given
 * MIME type. Cleans up the object URL on the next animation frame.
 */
export function downloadFile(filename: string, text: string, mime = "text/markdown"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  requestAnimationFrame(() => {
    a.remove();
    URL.revokeObjectURL(url);
  });
}
