/**
 * Pure (non-React) helpers + types extracted out of `SessionLog.tsx`.
 *
 * Keeping these in a separate module:
 *   - lets us unit-test the parsing logic without rendering React,
 *   - makes the main component file (still ~2000 lines of view code)
 *     easier to navigate,
 *   - and avoids accidentally pulling JSX into a code path the parent
 *     renders server-side.
 *
 * Anything that touches React state, hooks, or JSX stays in
 * `SessionLog.tsx` — the boundary is "pure functions over plain
 * data only".
 */

export type ActiveRun = {
  sessionId: string;
  repoPath: string;
  role: string;
  repo: string;
};

export interface ImageSource {
  type?: string;             // "base64" | "url"
  media_type?: string;       // image/png, image/jpeg…
  data?: string;             // base64 payload (sans data: prefix)
  url?: string;              // when source.type === "url"
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
  /** Present on `image` content blocks (Anthropic vision). */
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
  /** Present on `ai-title` entries — Claude Code's auto-generated session title. */
  aiTitle?: string;
  message?: {
    role?: string;
    id?: string;
    content?: string | ContentBlock[];
    /** Present on assistant turns; carries per-turn token accounting. */
    usage?: UsageBlock;
    /** Anthropic API stop reason: end_turn / tool_use / max_tokens / refusal / stop_sequence. */
    stop_reason?: string;
  };
}

export interface ParsedAttachment {
  rawPath: string;     // absolute path on disk, as written into the .jsonl
  name: string;        // basename
  size?: number;
  isImage: boolean;
}

export type Kind = "user" | "assistant" | "tool_result" | "hidden";

// .jsonl is a stream of every event; most are noise to a chat reader.
// `ai-title` carries the auto-generated session title (surfaced in the
// header instead of as a chat row); `last-prompt` is the leaf-pointer
// stub Claude writes to track resume targets; `file-history-snapshot`
// is the Edit-tool's per-file diff cache. None belong in the transcript.
export const HIDDEN_TYPES = new Set([
  "queue-operation", "attachment", "summary",
  "system-prompt-injection", "command-message",
  "ai-title", "last-prompt", "file-history-snapshot",
]);

export const MAX_RENDERED = 300;

export function classify(entry: LogEntry): Kind {
  if (HIDDEN_TYPES.has(entry.type ?? "")) return "hidden";
  if (entry.type === "user") {
    const c = entry.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return "tool_result";
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

// Tags Claude re-emits inside user / tool_result messages that are pure
// internal scaffolding — IDE breadcrumbs, slash-command echoes, system
// reminders. Hide them. Only well-known tags are stripped, never arbitrary
// `<foo>` the user might have actually typed.
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
  // Run repeatedly to catch nested cases. Cap iterations to avoid infinite
  // loops on weird inputs.
  let prev = text;
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(SYSTEM_TAG_RE, "");
    if (next === prev) break;
    prev = next;
  }
  // Collapse 3+ newlines left behind to a single blank line.
  return prev.replace(/\n{3,}/g, "\n\n").trim();
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  // Show the most useful single field for common tools.
  const primary = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.query ?? o.description;
  if (typeof primary === "string") return primary.length > 90 ? primary.slice(0, 90) + "…" : primary;
  return "";
}

export function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text ?? "");
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

// `mcp__plugin_<plugin>_<server>__<toolname>` → "playwright · browser navigate".
// Built-in tool names (Bash / Read / Edit / etc.) pass through unchanged.
export function prettyToolName(raw: string): string {
  if (!raw) return raw;
  if (!raw.startsWith("mcp__plugin_")) return raw;
  const rest = raw.slice("mcp__plugin_".length);
  // rest is `<plugin>_<server>__<toolname>` typically — the first `__`
  // separates the server-prefix part from the actual tool name.
  const sepIdx = rest.indexOf("__");
  if (sepIdx === -1) return rest.replace(/__/g, " · ").replace(/_/g, " ");
  const head = rest.slice(0, sepIdx);
  const tail = rest.slice(sepIdx + 2);
  // head looks like `playwright_playwright` or `context7_context7` —
  // collapse repeats to one label.
  const headParts = head.split("_").filter(Boolean);
  const dedup: string[] = [];
  for (const p of headParts) if (dedup[dedup.length - 1] !== p) dedup.push(p);
  const label = dedup.join(" ");
  const toolPretty = tail.replace(/__/g, " · ").replace(/_/g, " ");
  return label ? `${label} · ${toolPretty}` : toolPretty;
}

// Pull image references out of a tool_result text body. Matches:
//   [<alt>](relative/path.png)   ← markdown image / link
//   relative/path.png            ← bare path on its own line
const IMG_MD_RE = /\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif))\)/gi;
const IMG_LINE_RE = /^([^\s<>][^\n]*\.(?:png|jpe?g|gif|webp|svg|bmp|avif))\s*$/gim;

export function extractImagePaths(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  IMG_MD_RE.lastIndex = 0;
  while ((m = IMG_MD_RE.exec(text)) !== null) out.add(m[1].trim());
  IMG_LINE_RE.lastIndex = 0;
  while ((m = IMG_LINE_RE.exec(text)) !== null) out.add(m[1].trim());
  return [...out].filter((p) => !/^https?:\/\//i.test(p));
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/**
 * Pull attachments out of a user message we sent. The composer prefixes
 * them with `Attached file: \`<abs path>\` (<name>, <bytes> bytes) — …`,
 * so we can recover them by line-matching that exact shape and strip
 * those lines from the display text.
 */
export function extractAttachments(text: string): { stripped: string; items: ParsedAttachment[] } {
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
  // Trim trailing blank lines left behind by stripped attachment block.
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  while (kept.length && !kept[0].trim()) kept.shift();
  return { stripped: kept.join("\n"), items };
}
