import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isValidSessionId } from "./validate";

export function pathToSlug(absPath: string): string {
  return absPath.replace(/[\\/:.]/g, "-");
}

export const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

export function projectDirFor(cwd: string): string {
  const slug = pathToSlug(cwd);
  const direct = join(CLAUDE_PROJECTS_ROOT, slug);
  try {
    const lower = slug.toLowerCase();
    for (const entry of readdirSync(CLAUDE_PROJECTS_ROOT)) {
      if (entry.toLowerCase() === lower) return join(CLAUDE_PROJECTS_ROOT, entry);
    }
  } catch { }
  return direct;
}

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
  if (dirResolved !== root && !dirResolved.startsWith(root + sep)) return null;
  if (!existsSync(dirResolved)) return null;

  return join(dirResolved, `${sessionId}.jsonl`);
}

export interface TailResult {
  lines: unknown[];
  offset: number;
  lineOffsets: number[];
}

const TAIL_CHUNK_BYTES = 256 * 1024;

export async function tailJsonl(filePath: string, fromOffset: number): Promise<TailResult> {
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
    const buf = Buffer.alloc(TAIL_CHUNK_BYTES);
    const lines: unknown[] = [];
    const lineOffsets: number[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let pendingStart = fromOffset;
    let consumed = 0;
    let lastNewlineAbsEnd = fromOffset;

    while (true) {
      const n = readSync(fd, buf, 0, TAIL_CHUNK_BYTES, fromOffset + consumed);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      let lineStartInChunk = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0A) continue;
        const absLineEnd = fromOffset + consumed + i + 1;
        const tailBytes = chunk.subarray(lineStartInChunk, i);
        const lineBytes = pending.length === 0
          ? tailBytes
          : Buffer.concat([pending, tailBytes]);
        if (lineBytes.length > 0) {
          const text = lineBytes.toString("utf8");
          try { lines.push(JSON.parse(text)); }
          catch { lines.push({ __raw: text, __parseError: true }); }
          lineOffsets.push(pendingStart);
        }
        lastNewlineAbsEnd = absLineEnd;
        pending = Buffer.alloc(0);
        pendingStart = absLineEnd;
        lineStartInChunk = i + 1;
      }
      if (lineStartInChunk < chunk.length) {
        const tailBytes = chunk.subarray(lineStartInChunk);
        pending = pending.length === 0
          ? Buffer.from(tailBytes)
          : Buffer.concat([pending, tailBytes]);
      }
      consumed += n;
      if (n < TAIL_CHUNK_BYTES) break;
    }
    return {
      lines,
      offset: lastNewlineAbsEnd,
      lineOffsets,
    };
  } finally {
    closeSync(fd);
  }
}

export interface TailBeforeResult {
  lines: unknown[];
  fromOffset: number;
  beforeOffset: number;
  lineOffsets: number[];
}

export async function tailJsonlBefore(
  filePath: string,
  beforeOffset: number,
  maxBytes: number = 64 * 1024,
): Promise<TailBeforeResult> {
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

export interface SessionEntry {
  sessionId: string;
  filePath: string;
  mtime: number;
  size: number;
  preview: string;
}

const SYSTEM_TAG_RE = /<(?:ide_opened_file|ide_selection|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/(?:ide_opened_file|ide_selection|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr)>/gi;

function cleanText(raw: string): string {
  return raw.replace(SYSTEM_TAG_RE, "").trim();
}

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
    return cleanText(combined);
  }
  return "";
}

const SCAN_HEAD_CACHE_MAX = 256;
const scanHeadCache = new Map<string, { hasRealEntry: boolean; preview: string }>();

function scanHeadCacheKey(path: string, mtimeMs: number, size: number): string {
  return `${path}:${mtimeMs}:${size}`;
}

function scanSessionHead(filePath: string): { hasRealEntry: boolean; preview: string } {
  let mtimeMs = 0;
  let size = 0;
  let cacheable = false;
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtime.getTime();
    size = st.size;
    cacheable = true;
  } catch { }
  if (cacheable) {
    const key = scanHeadCacheKey(filePath, mtimeMs, size);
    const hit = scanHeadCache.get(key);
    if (hit) {
      scanHeadCache.delete(key);
      scanHeadCache.set(key, hit);
      return hit;
    }
    const value = scanSessionHeadUncached(filePath);
    scanHeadCache.set(key, value);
    if (scanHeadCache.size > SCAN_HEAD_CACHE_MAX) {
      const oldest = scanHeadCache.keys().next().value;
      if (oldest !== undefined) scanHeadCache.delete(oldest);
    }
    return value;
  }
  return scanSessionHeadUncached(filePath);
}

export function __resetScanHeadCacheForTests(): void {
  scanHeadCache.clear();
}

function scanSessionHeadUncached(filePath: string): { hasRealEntry: boolean; preview: string } {
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
    } catch { }
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
    try { closeSync(fd); } catch { }
  }
}

export function listSessions(projectDir: string): SessionEntry[] {
  let files: string[];
  try { files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")); }
  catch { return []; }

  const out: SessionEntry[] = [];
  for (const f of files) {
    const p = join(projectDir, f);
    let st;
    try { st = statSync(p); } catch { continue; }

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

export function readSessionCwd(filePath: string): string | null {
  let head: string;
  try { head = readFileSync(filePath, "utf8").slice(0, 16384); }
  catch { return null; }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
    } catch { }
  }
  return null;
}

export function discoverOrphanProjects(
  excludeDirs: Set<string>,
): Array<{ name: string; path: string; projectDir: string }> {
  let entries: string[];
  try { entries = readdirSync(CLAUDE_PROJECTS_ROOT); }
  catch { return []; }

  const out: Array<{ name: string; path: string; projectDir: string }> = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const projectDir = join(CLAUDE_PROJECTS_ROOT, name);
    if (excludeDirs.has(projectDir)) continue;
    let st;
    try { st = statSync(projectDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const sessions = listSessions(projectDir);
    if (sessions.length === 0) continue;

    const cwd = readSessionCwd(sessions[0]!.filePath);
    const path = cwd ?? name;
    const folderName = cwd ? basename(cwd) : name;
    out.push({ name: folderName, path, projectDir });
  }
  return out;
}
