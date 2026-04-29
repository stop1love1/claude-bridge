/**
 * Auto-memory distillation.
 *
 * Spawned by `coordinator.ts:postExitFlow` AFTER all post-exit gates
 * pass on a successful run, only when the target app has opted in via
 * `bridge.json.apps[].memory.distill = true`. The distill agent reads
 * the run's report, the diff, the task body, and any prior memory
 * entries, then proposes 1-3 NEW durable rules in the form
 * `When X → do Y because Z` for `<appPath>/.bridge/memory.md`.
 *
 * The bridge appends those entries via `appendMemory`, which already
 * dedupes against the most-recent line and caps the file size. So a
 * runaway distiller can't blow up the file or duplicate yesterday's
 * rule by accident.
 *
 * Skipped (no entries written) when:
 *   - the run is itself a retry (the coder we'd judge wasn't the
 *     primary attempt — the lesson belongs to the original)
 *   - the run produced no diff (read-only / planning runs)
 *   - the agent's verdict file is missing or malformed
 *   - the agent returned 0 entries (judged "nothing worth saving")
 *
 * Cost: opt-in per app, ~5-30K tokens per task on top of the coder.
 * Operators with token budget concerns leave it off by default.
 */
import { join } from "node:path";
import { appendMemory, topMemoryEntries } from "./memory";
import type { Run } from "./meta";
import { getApp } from "./apps";
import { runAgentGate, type AgentGateOutcome } from "./qualityGate";

export const MEMORY_DISTILL_ROLE = "memory-distill";
const VERDICT_FILE = "memory-distill-verdict.json";
const ENTRIES_CAP = 3;

const BRIEF_BODY = [
  "Read the task body, the prior coder's report, and `git diff HEAD` (or, when HEAD has no commits yet, `git status --porcelain` + targeted per-file diffs) to understand what shipped and why.",
  "",
  "Then propose AT MOST 3 NEW durable learnings worth remembering for future tasks in this app. Each rule must be:",
  "",
  "- A SINGLE sentence in the user's language, ≤ 200 chars.",
  "- Format: `When <trigger> → do <action> because <reason>.`",
  "- ACTIONABLE — a future agent can apply it without re-deriving the context.",
  "- NOT a one-off task detail (\"the user wanted X this time\") — must generalize.",
  "- NOT already in `## Memory` from prior tasks (you've been shown those — don't repeat them).",
  "- NOT a contradiction of `## House rules` or `## House style`.",
  "",
  "If you have NOTHING worth remembering — say so explicitly via an empty `entries` array. \"No learnings\" is a valid, frequent verdict; don't pad with filler.",
  "",
  "Write the verdict file before exiting. The bridge appends each entry to `.bridge/memory.md` (newest first, deduped). Do NOT edit that file yourself.",
].join("\n");

export interface MemoryDistillResult {
  /** Number of entries actually appended (some may be deduped against prior). */
  appended: number;
  /** sessionId of the spawned distill agent — for cross-ref + UI surfacing. */
  distillSessionId: string | null;
  /** One-line human summary; surfaced in logs / future UI. */
  reason: string;
  durationMs: number;
}

export interface RunMemoryDistillOptions {
  appPath: string;
  taskId: string;
  finishedRun: Run;
  taskTitle: string;
  taskBody: string;
}

/**
 * Validate the agent-supplied JSON shape `{entries: string[]}`. Defensive
 * against an LLM that wrote extra fields, missed the array, or stuffed
 * non-strings. Returns `null` on bad shape so the caller can skip
 * cleanly.
 */
export function parseDistillVerdict(
  raw: unknown,
): { entries: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entries = r.entries;
  if (!Array.isArray(entries)) return null;
  const cleaned = entries
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return { entries: cleaned.slice(0, ENTRIES_CAP) };
}

/**
 * Run the distillation gate end-to-end. Always returns — failures are
 * surfaced as `{appended: 0, reason: ...}` so the caller can log and
 * move on. Never throws.
 */
export async function runMemoryDistill(
  opts: RunMemoryDistillOptions,
): Promise<MemoryDistillResult> {
  const start = Date.now();
  const skipped = (
    reason: string,
    sessionId?: string | null,
  ): MemoryDistillResult => ({
    appended: 0,
    distillSessionId: sessionId ?? null,
    reason,
    durationMs: Date.now() - start,
  });

  const app = getApp(opts.finishedRun.repo);
  if (!app) return skipped("app not registered");
  if (!app.memory.distill) return skipped("memory.distill disabled for app");

  // Inject the current memory snapshot into the brief so the distiller
  // can avoid duplicating prior rules. `appendMemory` also dedupes
  // against the very newest line, but giving the agent the full visible
  // set lets it skip semantically-equivalent rules earlier in the file
  // too.
  const priorEntries = topMemoryEntries(app.path);
  const priorBlock =
    priorEntries.length > 0
      ? [
          "",
          "## Already remembered (skip if your candidate is a near-duplicate)",
          "",
          ...priorEntries.map((e) => (e.startsWith("-") ? e : `- ${e}`)),
          "",
        ].join("\n")
      : "";
  const briefBody = BRIEF_BODY + priorBlock;

  const outcome: AgentGateOutcome = await runAgentGate({
    appPath: opts.appPath,
    taskId: opts.taskId,
    finishedRun: opts.finishedRun,
    taskTitle: opts.taskTitle,
    taskBody: opts.taskBody,
    role: MEMORY_DISTILL_ROLE,
    briefBody,
    verdictFileName: VERDICT_FILE,
  });

  if (outcome.kind === "skipped") {
    return skipped(outcome.reason, outcome.sessionId ?? null);
  }

  const parsed = parseDistillVerdict(outcome.verdict);
  if (!parsed) {
    return skipped(
      "verdict file did not match `{entries: string[]}` schema",
      outcome.sessionId,
    );
  }
  if (parsed.entries.length === 0) {
    return {
      appended: 0,
      distillSessionId: outcome.sessionId,
      reason: "agent returned no entries (judged: nothing worth remembering)",
      durationMs: Date.now() - start,
    };
  }

  let appended = 0;
  // appendMemory mutates the file head-first and dedupes against the
  // current top entry. Multiple writes in sequence work correctly: each
  // appended entry becomes the new head and the next dedup compares
  // against it. So if the LLM proposed two near-identical rules, the
  // second is dropped automatically.
  for (const entry of parsed.entries) {
    const written = appendMemory(app.path, entry);
    if (written) appended += 1;
  }

  return {
    appended,
    distillSessionId: outcome.sessionId,
    reason:
      appended === parsed.entries.length
        ? `appended ${appended} entr${appended === 1 ? "y" : "ies"}`
        : `appended ${appended}/${parsed.entries.length} (rest deduped)`,
    durationMs: Date.now() - start,
  };
}

/** Test-only export — verdict file basename. */
export function _verdictFileName(): string {
  return VERDICT_FILE;
}

/** Test-only export — sessions dir helper. */
export function _verdictPath(taskId: string, sessionsDir: string): string {
  return join(sessionsDir, taskId, VERDICT_FILE);
}
