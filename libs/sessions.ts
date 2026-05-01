import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isValidSessionId } from "./validate";

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

export const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

/**
 * Resolve the actual on-disk session directory for a given cwd. Always
 * looks the folder up by case-insensitive match against `readdirSync`
 * so the returned path uses the canonical casing the FS chose when
 * `claude` created it. We can't trust `existsSync(direct)` to short-
 * circuit here — Windows' filesystem is case-insensitive, so the call
 * returns true even when the slug we built differs from the on-disk
 * folder by case. Without this, callers comparing path strings (e.g.
 * the orphan-project dedupe in `/api/sessions/all`) miss matches and
 * surface the same folder twice with different cases.
 */
export function projectDirFor(cwd: string): string {
  const slug = pathToSlug(cwd);
  const direct = join(CLAUDE_PROJECTS_ROOT, slug);
  try {
    const lower = slug.toLowerCase();
    for (const entry of readdirSync(CLAUDE_PROJECTS_ROOT)) {
      if (entry.toLowerCase() === lower) return join(CLAUDE_PROJECTS_ROOT, entry);
    }
  } catch { /* projects root may not exist yet */ }
  return direct;
}

/**
 * Resolve and validate a session-jsonl file path for a given
 * (`repoPath`, `sessionId`) pair coming off an HTTP request. Returns
 * the absolute file path the caller may safely read from, or `null` if
 * the request looks pathological / unauthorized.
 *
 * Why a dedicated helper instead of inlining `join(projectDirFor(repo),
 * sid + ".jsonl")` per route:
 *
 *   - **Path-traversal defense in depth.** `pathToSlug` already strips
 *     `/` `\` `:` `.` so the slug can't contain a separator, but a
 *     future change to that substitution must not silently re-open the
 *     hole. We re-verify the resolved path stays inside
 *     `CLAUDE_PROJECTS_ROOT` after `path.resolve` normalization.
 *   - **No probing arbitrary Claude project dirs.** Without this check,
 *     an authenticated client could pass `repo=/some/other/project` and
 *     read its session transcripts. We require the slug to point at a
 *     directory that already exists on disk — i.e. a real Claude Code
 *     project the bridge would surface in `/api/sessions/all` anyway.
 *     New / fictional paths get a 400 instead of a probe-by-status-code.
 *   - **Input shape.** Reject NUL bytes and oversize repo strings up
 *     front; reject malformed session ids via `isValidSessionId`.
 *
 * Callers turn `null` into `400 Bad Request` (or 404 — both are
 * acceptable; the helper deliberately doesn't distinguish so the wire
 * doesn't leak which check failed).
 */
export function resolveSessionFile(
  repoPath: unknown,
  sessionId: unknown,
): string | null {
  if (typeof repoPath !== "string" || typeof sessionId !== "string") return null;
  if (!repoPath || repoPath.length > 4096) return null;
  if (repoPath.includes("\0")) return null;
  if (!isValidSessionId(sessionId)) return null;

  const dir = projectDirFor(repoPath);
  const root = resolve(CLAUDE_PROJECTS_ROOT);
  const dirResolved = resolve(dir);
  // Containment: path.resolve normalizes any `..` that survived slug
  // substitution; the result must still be under CLAUDE_PROJECTS_ROOT.
  if (dirResolved !== root && !dirResolved.startsWith(root + sep)) return null;
  // The slugged dir must already exist. This is what restricts callers
  // to project dirs the user has actually used Claude Code in — no
  // fishing for arbitrary slugs.
  if (!existsSync(dirResolved)) return null;

  return join(dirResolved, `${sessionId}.jsonl`);
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
  // The file may be deleted between this call and the next (task
  // delete races a live SSE tail). Wrap stat + open in a try so a
  // missing file degrades to "no new lines" rather than throwing
  // ENOENT into the SSE handler and dropping the connection.
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { lines: [], offset: fromOffset, lineOffsets: [] };
  }
  if (fromOffset >= size) return { lines: [], offset: size, lineOffsets: [] };
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return { lines: [], offset: fromOffset, lineOffsets: [] };
  }
  try {
    // The file size we just read could shrink between stat and read (log
    // rotation, task delete, truncation). `readSync` reports the actual
    // bytes pulled — slice to that, never trust the original size.
    const buf = Buffer.alloc(size - fromOffset);
    const bytesRead = readSync(fd, buf, 0, buf.length, fromOffset);
    if (bytesRead === 0) return { lines: [], offset: fromOffset, lineOffsets: [] };
    const data = buf.subarray(0, bytesRead);
    // Work on raw bytes for offset bookkeeping. `\n` (0x0A) is a single
    // byte in UTF-8 and never appears inside a multi-byte sequence, so
    // splitting on byte boundaries is correct even if the read sliced a
    // multi-byte char at the tail (we exclude that partial trailing line
    // by stopping at the last `\n` byte).
    const lastNewlineByte = data.lastIndexOf(0x0A);
    if (lastNewlineByte === -1) return { lines: [], offset: fromOffset, lineOffsets: [] };
    const lines: unknown[] = [];
    const lineOffsets: number[] = [];
    let lineStart = 0;
    for (let i = 0; i <= lastNewlineByte; i++) {
      if (data[i] !== 0x0A) continue;
      const lineBytes = data.subarray(lineStart, i);
      if (lineBytes.length > 0) {
        const text = lineBytes.toString("utf8");
        try { lines.push(JSON.parse(text)); }
        catch { lines.push({ __raw: text, __parseError: true }); }
        lineOffsets.push(fromOffset + lineStart);
      }
      lineStart = i + 1;
    }
    return {
      lines,
      offset: fromOffset + lastNewlineByte + 1,
      lineOffsets,
    };
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
  // Same race tolerance as tailJsonl: the file can disappear between
  // the SSE-side check and our stat/open.
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { lines: [], fromOffset: 0, beforeOffset, lineOffsets: [] };
  }
  const ceiling = Math.min(beforeOffset, size);
  if (ceiling <= 0) return { lines: [], fromOffset: 0, beforeOffset: ceiling, lineOffsets: [] };

  const proposedStart = Math.max(0, ceiling - maxBytes);
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return { lines: [], fromOffset: ceiling, beforeOffset: ceiling, lineOffsets: [] };
  }
  try {
    const len = ceiling - proposedStart;
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, proposedStart);
    if (bytesRead === 0) {
      return { lines: [], fromOffset: ceiling, beforeOffset: ceiling, lineOffsets: [] };
    }
    const data = buf.subarray(0, bytesRead);

    // If we did not start at byte 0, the first line in `data` is almost
    // certainly the tail of a record that began before our window —
    // skip past it. Operate on raw bytes so the offset stays correct
    // when a multi-byte UTF-8 char straddles `proposedStart`.
    let dataStart = 0;
    let startByte = proposedStart;
    if (proposedStart > 0) {
      const firstNl = data.indexOf(0x0A);
      if (firstNl === -1) {
        return { lines: [], fromOffset: ceiling, beforeOffset: ceiling, lineOffsets: [] };
      }
      dataStart = firstNl + 1;
      startByte = proposedStart + dataStart;
    }

    // Drop a trailing partial line. With a clean `beforeOffset` from the
    // caller this is usually a no-op, but handle it defensively.
    const lastNl = data.lastIndexOf(0x0A);
    const endByte = lastNl === -1 ? dataStart : lastNl;
    if (endByte <= dataStart) {
      return { lines: [], fromOffset: ceiling, beforeOffset: ceiling, lineOffsets: [] };
    }

    const lines: unknown[] = [];
    const lineOffsets: number[] = [];
    let lineStart = dataStart;
    for (let i = dataStart; i <= endByte; i++) {
      if (data[i] !== 0x0A) continue;
      const lineBytes = data.subarray(lineStart, i);
      if (lineBytes.length > 0) {
        const text = lineBytes.toString("utf8");
        try { lines.push(JSON.parse(text)); }
        catch { lines.push({ __raw: text, __parseError: true }); }
        lineOffsets.push(proposedStart + lineStart);
      }
      lineStart = i + 1;
    }
    return {
      lines,
      fromOffset: lineOffsets[0] ?? startByte,
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
 * Stream a .jsonl session file in 16 KB chunks, returning whether it
 * contains at least one real conversation turn (`user` / `assistant` /
 * `summary`) and the first user-line preview if present. Bounded at
 * `MAX_BYTES` so a runaway file can't pin the bridge — at that point we
 * conservatively treat whatever we've seen so far as the answer (almost
 * always: a real session whose user line lives even further in, included).
 *
 * Streaming (vs. a fixed-size head slice) is required because modern
 * Claude Code transcripts begin with a `queue-operation` + a multi-KB
 * `attachment` payload — the first user/assistant/summary entry routinely
 * lives well past byte 8192. A small head window silently hides every such
 * session as a "stub".
 */
function scanSessionHead(filePath: string): { hasRealEntry: boolean; preview: string } {
  let fd: number;
  try { fd = openSync(filePath, "r"); }
  catch { return { hasRealEntry: false, preview: "" }; }

  const CHUNK = 16 * 1024;
  const MAX_BYTES = 4 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  const decoder = new StringDecoder("utf8");
  let leftover = "";
  let preview = "";
  let hasRealEntry = false;
  let pos = 0;

  const consume = (line: string) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (obj.type === "user" || obj.type === "assistant" || obj.type === "summary") {
        hasRealEntry = true;
        if (!preview && obj.type === "user") {
          preview = extractText(obj.message?.content).trim().replace(/\s+/g, " ").slice(0, 120);
        }
      }
    } catch { /* partial / malformed — keep scanning */ }
  };

  try {
    while (pos < MAX_BYTES) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const text = leftover + decoder.write(buf.subarray(0, n));
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) { leftover = text; continue; }
      const ready = text.slice(0, lastNl);
      leftover = text.slice(lastNl + 1);
      for (const line of ready.split("\n")) {
        consume(line);
        if (hasRealEntry && preview) return { hasRealEntry, preview };
      }
    }
    consume(leftover + decoder.end());
    return { hasRealEntry, preview };
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
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

    // Claude Code writes leaf-pointer stub files (`{"type":"last-prompt",…}`)
    // to track resume/rewind targets — they share the .jsonl extension but
    // contain no real conversation. Surface only files that have at least
    // one user/assistant/summary turn so these stubs don't show up as empty
    // "orphan" sessions in the panel. We must stream chunks (not slice a
    // fixed-size head) because modern transcripts begin with a
    // `queue-operation` + multi-KB `attachment` line that can push the
    // first real entry well past any small head window.
    const { hasRealEntry, preview } = scanSessionHead(p);
    if (!hasRealEntry) continue;

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

/**
 * Recover the absolute `cwd` Claude Code recorded when it created a
 * session. The slug-encoding `pathToSlug` uses is lossy (every `/`,
 * `\`, `:`, and `.` collapses to `-`), so we can't reverse a project
 * folder name back to a path on disk reliably. But every transcript
 * line carries the original cwd as a field — read the first lines until
 * we find one and pull it out. Used to surface sessions whose project
 * folder isn't a bridge sibling (worktrees, unrelated repos, etc).
 */
export function readSessionCwd(filePath: string): string | null {
  let head: string;
  try { head = readFileSync(filePath, "utf8").slice(0, 16384); }
  catch { return null; }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
    } catch { /* partial / malformed line — keep scanning */ }
  }
  return null;
}

/**
 * Scan `~/.claude/projects/` for project folders we haven't already
 * covered via the explicit repos list, and return one entry per folder
 * with the cwd recovered from its newest session. The caller decides
 * how to render these (typically as additional groups in the sessions
 * list). `excludeDirs` is the set of project-dir paths already emitted
 * — anything in it is skipped to avoid duplicate groups.
 */
export function discoverOrphanProjects(
  excludeDirs: Set<string>,
): Array<{ name: string; path: string; projectDir: string }> {
  let entries: string[];
  try { entries = readdirSync(CLAUDE_PROJECTS_ROOT); }
  catch { return []; }

  const out: Array<{ name: string; path: string; projectDir: string }> = [];
  for (const name of entries) {
    // Dot-prefixed entries are claude-internal backups (`.bak`,
    // `.tombstones`, etc.) — they may contain stale `.jsonl` files
    // whose `cwd` collides with a live project, which would surface the
    // same folder twice with subtly different casing. Skip them, same
    // way the bridge's sibling-iteration filter does.
    if (name.startsWith(".")) continue;
    const projectDir = join(CLAUDE_PROJECTS_ROOT, name);
    if (excludeDirs.has(projectDir)) continue;
    let st;
    try { st = statSync(projectDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const sessions = listSessions(projectDir);
    if (sessions.length === 0) continue;

    // The newest session is usually the freshest source of truth — read
    // its cwd. Fall back to the slug itself if no cwd field is present
    // (very old files, manually placed jsonl, etc.) so the group is at
    // least visible rather than silently dropped.
    const cwd = readSessionCwd(sessions[0]!.filePath);
    const path = cwd ?? name;
    const folderName = cwd ? basename(cwd) : name;
    out.push({ name: folderName, path, projectDir });
  }
  return out;
}
