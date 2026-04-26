/**
 * P5/G1 — per-app memory.md.
 *
 * After a task completes the user (or the coordinator on behalf of the
 * user) can append 1–3 lines to `<appPath>/.bridge/memory.md` capturing
 * "what we learned" — durable rules in the form `When X → do Y because Z`.
 * The bridge inlines the latest N entries into every spawn for the same
 * app via `## Memory` so the next agent benefits from prior tasks.
 *
 * Storage convention:
 *   - File path: `<appPath>/.bridge/memory.md`. Operator picks gitignore
 *     policy per-app (some teams want it tracked, others don't).
 *   - Newest entry FIRST in the file. Each entry is a single bullet
 *     line; multi-line guidance should be flattened into one bullet.
 *   - Total file capped at MAX_FILE_BYTES (32 KB). On overflow, the
 *     oldest entries get dropped on append.
 *
 * Distinct from `lib/houseRules.ts`:
 *   - houseRules = STATIC team constraints, hand-written.
 *   - memory     = DYNAMIC learnings, accreted via `appendMemory`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const MEMORY_DIR_NAME = ".bridge";
export const MEMORY_FILE_NAME = "memory.md";
const MAX_FILE_BYTES = 32 * 1024;
const MAX_ENTRY_BYTES = 1024;
const PROMPT_INJECT_LIMIT = 12;

export function memoryFilePath(appPath: string): string {
  return join(appPath, MEMORY_DIR_NAME, MEMORY_FILE_NAME);
}

/**
 * Read the raw memory file for an app. Returns `null` when the file is
 * missing OR the appPath is invalid — callers treat both as "no
 * memory yet". Capped at `MAX_FILE_BYTES` so a runaway file never
 * blows up the prompt.
 */
export function loadMemory(appPath: string | null): string | null {
  if (!appPath || !isAbsolute(appPath)) return null;
  const file = memoryFilePath(appPath);
  if (!existsSync(file)) return null;
  try {
    const buf = readFileSync(file);
    const text = buf.subarray(0, MAX_FILE_BYTES).toString("utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Pull the top N bullet entries from a memory file. Used by
 * `buildChildPrompt` when injecting `## Memory`. Strips empty lines
 * and ignores anything past the cap so a noisy memory file doesn't
 * dominate the prompt budget.
 *
 * Splits on newline boundaries; the convention in `appendMemory` is
 * one bullet per line, so this works without a markdown parser.
 */
export function topMemoryEntries(
  appPath: string | null,
  limit: number = PROMPT_INJECT_LIMIT,
): string[] {
  const raw = loadMemory(appPath);
  if (!raw) return [];
  const out: string[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // headers, if the operator added any
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Append a memory entry to the head of the file. The entry text is
 * trimmed, capped at `MAX_ENTRY_BYTES`, and emitted as a single bullet
 * line. The file as a whole is then truncated to `MAX_FILE_BYTES`,
 * dropping oldest entries first (we keep newest at the top so cap
 * trimming naturally evicts what's least relevant).
 *
 * Returns the new entry as actually persisted, or `null` if the
 * caller's input was unusable (empty, non-string, app path invalid).
 *
 * Idempotent against duplicates: if the most recent entry is byte-
 * for-byte identical to the new one (after trim), we no-op. Avoids the
 * coordinator double-appending if a retry triggers the same hook.
 */
export function appendMemory(
  appPath: string | null,
  entry: string,
): string | null {
  if (!appPath || !isAbsolute(appPath)) return null;
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  if (!trimmed) return null;

  // Flatten newlines + leading bullet markers so each appended entry
  // is exactly one line in the file.
  const flattened = trimmed
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_ENTRY_BYTES);
  const bullet = `- ${flattened}`;

  const existing = loadMemory(appPath);
  if (existing) {
    // Idempotency check against the first non-empty line.
    const firstLine = existing.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    if (firstLine.trim() === bullet) return bullet;
  }

  const next = existing ? `${bullet}\n${existing}` : bullet;
  // Byte-aware truncation so multi-byte (Vietnamese / emoji / CJK)
  // entries don't produce a half-codepoint cut. `Buffer.subarray`
  // is byte-indexed; `Buffer#toString("utf8")` then re-encodes,
  // dropping the final 1-3 trailing bytes of any partial codepoint
  // at the cap boundary. After byte-trim we also drop any partial
  // trailing line (anything after the last `\n` in the trimmed
  // buffer) so `topMemoryEntries` never serves a half-bullet.
  let capped = next;
  if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) {
    const trimmed = Buffer.from(next, "utf8")
      .subarray(0, MAX_FILE_BYTES)
      .toString("utf8");
    const lastNl = trimmed.lastIndexOf("\n");
    capped = lastNl >= 0 ? trimmed.slice(0, lastNl) : trimmed;
  }

  const file = memoryFilePath(appPath);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, capped + "\n");
  } catch {
    return null;
  }
  return bullet;
}

/**
 * Render the prompt section. Returns "" when there's nothing to surface
 * so `buildChildPrompt` can skip the heading entirely.
 */
export function renderMemorySection(entries: string[]): string {
  if (entries.length === 0) return "";
  return [
    "## Memory (learnings from prior tasks in this app)",
    "",
    "Durable rules accreted from past tasks. Format `When X → do Y because Z`. Honor these unless the current task explicitly overrides — the team chose to remember each one for a reason.",
    "",
    ...entries.map((e) => (e.startsWith("-") ? e : `- ${e}`)),
    "",
  ].join("\n");
}
