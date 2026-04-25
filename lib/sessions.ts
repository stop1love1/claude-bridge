import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Convert an absolute path to Claude Code's project slug convention.
 * Claude collapses path separators (/, \), drive colons (:), AND dots (.)
 * all to dashes — so `C:\projects\my-bridge` becomes
 * `C--projects-my-bridge` and `/home/u/my.bridge` becomes
 * `-home-u-my-bridge`.
 */
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[\\/:.]/g, "-");
}

const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

/**
 * Resolve the actual on-disk session directory for a given cwd.
 * Falls back to a case-insensitive lookup so Windows drive-letter case
 * (`D:` vs `d:`) doesn't desync from whatever case `claude` saw when it
 * created the folder.
 */
export function projectDirFor(cwd: string): string {
  const slug = pathToSlug(cwd);
  const direct = join(CLAUDE_PROJECTS_ROOT, slug);
  if (existsSync(direct)) return direct;
  try {
    const lower = slug.toLowerCase();
    for (const entry of readdirSync(CLAUDE_PROJECTS_ROOT)) {
      if (entry.toLowerCase() === lower) return join(CLAUDE_PROJECTS_ROOT, entry);
    }
  } catch { /* projects root may not exist yet */ }
  return direct;
}

export interface TailResult {
  lines: unknown[];
  offset: number;
  /**
   * Byte offset where each parsed line BEGINS in the file. Parallel to
   * `lines`. Frontends use this to track the earliest-loaded cursor when
   * trimming or backward-paging.
   */
  lineOffsets: number[];
}

export async function tailJsonl(filePath: string, fromOffset: number): Promise<TailResult> {
  const size = statSync(filePath).size;
  if (fromOffset >= size) return { lines: [], offset: size, lineOffsets: [] };
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size - fromOffset);
    readSync(fd, buf, 0, buf.length, fromOffset);
    const raw = buf.toString("utf8");
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline === -1) return { lines: [], offset: fromOffset, lineOffsets: [] };
    const complete = raw.slice(0, lastNewline);
    const parts = complete.split("\n");
    const lines: unknown[] = [];
    const lineOffsets: number[] = [];
    let cursor = fromOffset;
    for (const l of parts) {
      const byteLen = Buffer.byteLength(l, "utf8");
      if (l.length > 0) {
        try { lines.push(JSON.parse(l)); }
        catch { lines.push({ __raw: l, __parseError: true }); }
        lineOffsets.push(cursor);
      }
      // +1 for the consumed newline that `split` removed.
      cursor += byteLen + 1;
    }
    return { lines, offset: fromOffset + Buffer.byteLength(complete, "utf8") + 1, lineOffsets };
  } finally {
    closeSync(fd);
  }
}

export interface TailBeforeResult {
  lines: unknown[];
  /**
   * Byte offset of the first complete line returned. Becomes the caller's
   * new earliest-loaded cursor. If 0, the start of the file has been
   * reached.
   */
  fromOffset: number;
  /**
   * Echo of the input ceiling so the client can detect stale responses.
   */
  beforeOffset: number;
  lineOffsets: number[];
}

/**
 * Read a window of complete lines that ENDS at `beforeOffset` (exclusive).
 * The window is at most `maxBytes` long, but always starts on a line
 * boundary — we scan forward past any partial leading line. Used to
 * paginate backward through a session.jsonl when the user scrolls up.
 */
export async function tailJsonlBefore(
  filePath: string,
  beforeOffset: number,
  maxBytes: number = 64 * 1024,
): Promise<TailBeforeResult> {
  const size = statSync(filePath).size;
  const ceiling = Math.min(beforeOffset, size);
  if (ceiling <= 0) return { lines: [], fromOffset: 0, beforeOffset: ceiling, lineOffsets: [] };

  const proposedStart = Math.max(0, ceiling - maxBytes);
  const fd = openSync(filePath, "r");
  try {
    const len = ceiling - proposedStart;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, proposedStart);
    const raw = buf.toString("utf8");

    // If we did not start at byte 0, the first line in `raw` is almost
    // certainly the tail of a record that began before our window —
    // skip past it. If we DID start at 0, the window is whole.
    let trimmedHead = raw;
    let startByte = proposedStart;
    if (proposedStart > 0) {
      const firstNl = raw.indexOf("\n");
      if (firstNl === -1) {
        // The whole window was a partial line — nothing usable.
        return { lines: [], fromOffset: ceiling, beforeOffset: ceiling, lineOffsets: [] };
      }
      const consumed = Buffer.byteLength(raw.slice(0, firstNl + 1), "utf8");
      startByte = proposedStart + consumed;
      trimmedHead = raw.slice(firstNl + 1);
    }

    // Drop a trailing partial line — but `beforeOffset` should already
    // be a line boundary if the caller used a previous fromOffset, so
    // typically there's nothing to trim here.
    const lastNl = trimmedHead.lastIndexOf("\n");
    const complete = lastNl === -1 ? trimmedHead : trimmedHead.slice(0, lastNl);

    const parts = complete.split("\n");
    const lines: unknown[] = [];
    const lineOffsets: number[] = [];
    let cursor = startByte;
    for (const l of parts) {
      const byteLen = Buffer.byteLength(l, "utf8");
      if (l.length > 0) {
        try { lines.push(JSON.parse(l)); }
        catch { lines.push({ __raw: l, __parseError: true }); }
        lineOffsets.push(cursor);
      }
      cursor += byteLen + 1;
    }
    return {
      lines,
      fromOffset: lineOffsets[0] ?? ceiling,
      beforeOffset: ceiling,
      lineOffsets,
    };
  } finally {
    closeSync(fd);
  }
}

export async function findSessionByPrefix(projectDir: string, prefix: string): Promise<string | null> {
  let files: string[];
  try { files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")); }
  catch { return null; }

  const candidates = files
    .map((f) => ({ path: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates) {
    try {
      const first = readFileSync(c.path, "utf8").split("\n", 1)[0];
      const obj = JSON.parse(first) as { type?: string; message?: { role?: string; content?: string } };
      const content = obj?.message?.content ?? "";
      if (obj.type === "user" && content.startsWith(prefix)) return c.path;
    } catch { /* skip malformed */ }
  }
  return null;
}

export interface SessionEntry {
  sessionId: string;     // filename without .jsonl
  filePath: string;
  mtime: number;         // ms since epoch
  size: number;          // bytes
  preview: string;       // first ~120 chars of the first user message (plain text)
}

/**
 * Tags claude-code (and the VS Code integration) wrap around the
 * first user message. They aren't user-typed and shouldn't dominate
 * the preview — strip them out before picking a title.
 */
const SYSTEM_TAG_RE = /<(?:ide_opened_file|ide_selection|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/(?:ide_opened_file|ide_selection|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr)>/gi;

function cleanText(raw: string): string {
  return raw.replace(SYSTEM_TAG_RE, "").trim();
}

/**
 * Pull the user-typed text out of a message content payload, ignoring
 * system-tag wrappers that the VS Code claude integration injects
 * (`<ide_opened_file>`, etc.). For an array of text blocks, returns
 * the first block that has real content after stripping; falls back
 * to a stripped concat if no block stands alone.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return cleanText(content);
  if (Array.isArray(content)) {
    let combined = "";
    for (const block of content) {
      let text = "";
      if (typeof block === "string") text = block;
      else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") text = b.text;
      }
      if (!text) continue;
      const cleaned = cleanText(text);
      if (cleaned) return cleaned;
      combined += " " + text;
    }
    // Every block was system-tag boilerplate — return whatever cleaned
    // text remains, even if it's empty.
    return cleanText(combined);
  }
  return "";
}

/**
 * List all Claude Code sessions (.jsonl) under a project directory.
 * Uses the standard ~/.claude/projects/<slug>/ layout — we never create
 * our own session files; we just read what claude wrote.
 */
export function listSessions(projectDir: string): SessionEntry[] {
  let files: string[];
  try { files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")); }
  catch { return []; }

  const out: SessionEntry[] = [];
  for (const f of files) {
    const p = join(projectDir, f);
    let st;
    try { st = statSync(p); } catch { continue; }

    let preview = "";
    try {
      const head = readFileSync(p, "utf8").slice(0, 8192);
      for (const line of head.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
          if (obj.type === "user") {
            preview = extractText(obj.message?.content).trim().replace(/\s+/g, " ").slice(0, 120);
            break;
          }
        } catch { /* partial line — keep scanning */ }
      }
    } catch { /* unreadable → leave preview empty */ }

    out.push({
      sessionId: f.replace(/\.jsonl$/, ""),
      filePath: p,
      mtime: st.mtimeMs,
      size: st.size,
      preview,
    });
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}
