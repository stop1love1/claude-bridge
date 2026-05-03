/**
 * Pure (non-React) helpers + types extracted out of the SessionLog
 * viewer. Ported verbatim from main with minimal trim — no React,
 * no JSX, no hooks: easy to test and to reuse from other surfaces
 * (markdown export, copy-all, etc.).
 */

export interface ImageSource {
  type?: string;
  media_type?: string;
  data?: string;
  url?: string;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  source?: ImageSource;
}

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface LogEntry {
  type?: string;
  timestamp?: string;
  uuid?: string;
  aiTitle?: string;
  message?: {
    role?: string;
    id?: string;
    content?: string | ContentBlock[];
    usage?: UsageBlock;
    stop_reason?: string;
  };
  [key: string]: unknown;
}

export interface ParsedAttachment {
  rawPath: string;
  name: string;
  size?: number;
  isImage: boolean;
}

export type Kind = "user" | "assistant" | "tool_result" | "hidden";

// .jsonl is a stream of every event; most are noise to a chat reader.
export const HIDDEN_TYPES = new Set([
  "queue-operation",
  "attachment",
  "summary",
  "system-prompt-injection",
  "command-message",
  "ai-title",
  "last-prompt",
  "file-history-snapshot",
]);

export const MAX_RENDERED = 300;

export function classify(entry: LogEntry): Kind {
  if (HIDDEN_TYPES.has(entry.type ?? "")) return "hidden";
  if (entry.type === "user") {
    const c = entry.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result"))
      return "tool_result";
    return "user";
  }
  if (entry.type === "assistant") return "assistant";
  return "hidden";
}

export function asBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

const SYSTEM_TAGS = [
  "system-reminder",
  "task-notification",
  "ide_opened_file",
  "ide_selection",
  "command-message",
  "command-name",
  "local-command-stdout",
  "local-command-stderr",
  "command-stdout",
  "command-stderr",
];
const SYSTEM_TAG_RE = new RegExp(
  `<(${SYSTEM_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  "g",
);

export function stripSystemTags(text: string): string {
  if (!text || text.indexOf("<") === -1) return text;
  let prev = text;
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(SYSTEM_TAG_RE, "");
    if (next === prev) break;
    prev = next;
  }
  return prev.replace(/\n{3,}/g, "\n\n").trim();
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const primary =
    o.file_path ??
    o.path ??
    o.command ??
    o.pattern ??
    o.url ??
    o.query ??
    o.description;
  if (typeof primary === "string")
    return primary.length > 90 ? primary.slice(0, 90) + "…" : primary;
  return "";
}

export function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b)
          return String((b as { text: unknown }).text ?? "");
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

export function prettyToolName(raw: string): string {
  if (!raw) return raw;
  if (!raw.startsWith("mcp__plugin_")) return raw;
  const rest = raw.slice("mcp__plugin_".length);
  const sepIdx = rest.indexOf("__");
  if (sepIdx === -1) return rest.replace(/__/g, " · ").replace(/_/g, " ");
  const head = rest.slice(0, sepIdx);
  const tail = rest.slice(sepIdx + 2);
  const headParts = head.split("_").filter(Boolean);
  const dedup: string[] = [];
  for (const p of headParts) if (dedup[dedup.length - 1] !== p) dedup.push(p);
  const label = dedup.join(" ");
  const toolPretty = tail.replace(/__/g, " · ").replace(/_/g, " ");
  return label ? `${label} · ${toolPretty}` : toolPretty;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function extractAttachments(text: string): {
  stripped: string;
  items: ParsedAttachment[];
} {
  const items: ParsedAttachment[] = [];
  const lines = text.split("\n");
  const kept: string[] = [];
  const re = /^Attached file:\s+`([^`]+)`\s*(?:\(([^)]+)\))?/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) {
      kept.push(line);
      continue;
    }
    const rawPath = m[1];
    const meta = m[2] ?? "";
    const sizeM = meta.match(/(\d+)\s*bytes?/i);
    const nameM = meta.split(",")[0]?.trim();
    const fallback = rawPath.split(/[\\/]/).pop() ?? rawPath;
    items.push({
      rawPath,
      name: nameM || fallback,
      size: sizeM ? Number(sizeM[1]) : undefined,
      isImage: IMG_EXT.test(rawPath),
    });
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  while (kept.length && !kept[0].trim()) kept.shift();
  return { stripped: kept.join("\n"), items };
}

/** Reduce a tool-call's input/output to a one-line preview. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Render the entire log as a plain-text markdown dump for the
 * "download as markdown" toolbar action. Lossless-ish — strips system
 * tags, collapses tool results to their first 200 chars.
 */
export function exportMarkdown(entries: LogEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const kind = classify(e);
    if (kind === "hidden") continue;
    const ts = e.timestamp ? ` _${e.timestamp}_` : "";
    if (kind === "user") {
      const text = stringifyResult(e.message?.content);
      const { stripped } = extractAttachments(text);
      lines.push(`### user${ts}\n\n${stripSystemTags(stripped)}\n`);
    } else if (kind === "assistant") {
      lines.push(`### assistant${ts}\n`);
      for (const b of asBlocks(e.message?.content)) {
        if (b.type === "text" && b.text) {
          lines.push(stripSystemTags(b.text));
          lines.push("");
        } else if (b.type === "thinking" && b.thinking) {
          lines.push(`> _thinking_: ${truncate(b.thinking, 240)}`);
          lines.push("");
        } else if (b.type === "tool_use") {
          const name = prettyToolName(b.name ?? "");
          const sum = summarizeInput(b.input);
          lines.push(`- **tool** \`${name}\`${sum ? ` — ${sum}` : ""}`);
        }
      }
    } else if (kind === "tool_result") {
      for (const b of asBlocks(e.message?.content)) {
        if (b.type === "tool_result") {
          const txt = truncate(stringifyResult(b.content), 200);
          lines.push(`> _tool_result_: ${txt}`);
          lines.push("");
        }
      }
    }
  }
  return lines.join("\n");
}
