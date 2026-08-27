
export type ActiveRun = {
  sessionId: string;
  repoPath: string;
  role: string;
  repo: string;
};

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
}

export interface AskUserOption {
  label: string;
  description?: string;
}
export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserOption[];
}

export function parseAskUserQuestion(input: unknown): AskUserQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return null;
  const out: AskUserQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const o = q as Record<string, unknown>;
    const optsRaw = Array.isArray(o.options) ? o.options : [];
    const options: AskUserOption[] = optsRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        label: typeof x.label === "string" ? x.label : "",
        description: typeof x.description === "string" ? x.description : undefined,
      }))
      .filter((x) => x.label.length > 0);
    out.push({
      question: typeof o.question === "string" ? o.question : "",
      header: typeof o.header === "string" ? o.header : "",
      multiSelect: o.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : null;
}

export function buildAnswerMessage(
  questions: AskUserQuestion[],
  selections: string[][],
): string {
  return questions
    .map((q, i) => {
      const picks = (selections[i] ?? []).map((s) => s.trim()).filter(Boolean);
      if (picks.length === 0) return null;
      const label = (q.header || q.question || `Question ${i + 1}`).trim();
      return `${label}: ${picks.join(", ")}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

export interface ParsedAttachment {
  rawPath: string;
  name: string;
  size?: number;
  isImage: boolean;
}

export type Kind = "user" | "assistant" | "tool_result" | "hidden";

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
  "task-id",
  "task-title",
  "task-body",
  "task-section",
  "task-status",
  "task-app",
  "task-checked",
];
const SYSTEM_TAG_RE = new RegExp(
  `<(${SYSTEM_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  "g",
);
const SYSTEM_TAG_OPEN_RE = new RegExp(
  `<(${SYSTEM_TAGS.join("|")})\\b[^>]*\\/?>`,
  "g",
);
const SYSTEM_TAG_CLOSE_RE = new RegExp(
  `<\\/(${SYSTEM_TAGS.join("|")})\\s*>`,
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
  prev = prev.replace(SYSTEM_TAG_OPEN_RE, "").replace(SYSTEM_TAG_CLOSE_RE, "");
  return prev.replace(/\n{3,}/g, "\n\n").trim();
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
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
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  while (kept.length && !kept[0].trim()) kept.shift();
  return { stripped: kept.join("\n"), items };
}
