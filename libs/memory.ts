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
    if (line.startsWith("#")) continue;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

export function appendMemory(
  appPath: string | null,
  entry: string,
): string | null {
  if (!appPath || !isAbsolute(appPath)) return null;
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const flattened = trimmed
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_ENTRY_BYTES);
  const bullet = `- ${flattened}`;

  const existing = loadMemory(appPath);
  if (existing) {
    const firstLine = existing.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    if (firstLine.trim() === bullet) return bullet;
  }

  const next = existing ? `${bullet}\n${existing}` : bullet;
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
