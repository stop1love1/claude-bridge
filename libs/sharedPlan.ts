/**
 * Shared plan loader. Reads `sessions/<task-id>/plan.md` AND every
 * `plan-<role>.md` (per-planner file) and concatenates them so the
 * agents route can inject the merged result into every downstream
 * child's prompt as `## Shared plan (from planner)`.
 *
 * The per-role file naming exists because operators frequently dispatch
 * multiple planners in parallel — `planner-api` + `planner-ui` for a
 * UI+API feature — and a single shared `plan.md` becomes a race target
 * (last write wins, one planner's work silently disappears). With
 * per-role files, each planner writes its own slot and the bridge
 * concatenates them here.
 *
 * Soft fail by design: missing files, unreadable files, empty files all
 * resolve to `null` (or just get skipped in the concat). The plan is
 * an enrichment, not a hard requirement.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SESSIONS_DIR } from "./paths";

/**
 * Hard cap on plan.md size injected into a child prompt. The planner
 * playbook tells the agent to keep `plan.md` under ~80 lines; this cap
 * is a defensive ceiling against a runaway planner blowing out every
 * downstream child's context window. Applied to the FINAL merged
 * output, not per-file.
 */
export const SHARED_PLAN_CAP_BYTES = 16 * 1024;

/** Canonical single-file path (legacy single-planner usage). */
export function sharedPlanPath(taskId: string): string {
  return join(SESSIONS_DIR, taskId, "plan.md");
}

/**
 * Per-role plan path. Each planner writes its own slot to prevent
 * parallel-planner races on the shared `plan.md`.
 */
export function rolePlanPath(taskId: string, role: string): string {
  // `role` is already gated to the agent-role charset upstream (see
  // `isValidAgentRole`), so we don't need to re-sanitize here.
  return join(SESSIONS_DIR, taskId, `plan-${role}.md`);
}

interface PlanSlot {
  /** `null` for the legacy unscoped plan.md, otherwise the role suffix. */
  role: string | null;
  text: string;
}

/**
 * Enumerate plan files for a task: `plan.md` (when present) plus every
 * `plan-<role>.md`. Returns them in stable order (unscoped first,
 * then per-role alphabetically) so the merged output is deterministic
 * across reads.
 */
function readPlanSlots(taskId: string): PlanSlot[] {
  const dir = join(SESSIONS_DIR, taskId);
  if (!existsSync(dir)) return [];
  const slots: PlanSlot[] = [];

  // Unscoped slot.
  const unscoped = sharedPlanPath(taskId);
  if (existsSync(unscoped)) {
    try {
      const text = readFileSync(unscoped, "utf8").trim();
      if (text.length > 0) slots.push({ role: null, text });
    } catch { /* skip */ }
  }

  // Per-role slots — enumerate via readdirSync (cheaper than glob).
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return slots; }
  const roleFiles = entries
    .filter((n) => n.startsWith("plan-") && n.endsWith(".md"))
    .sort();
  for (const name of roleFiles) {
    const role = name.slice("plan-".length, -".md".length);
    if (!role) continue;
    try {
      const text = readFileSync(join(dir, name), "utf8").trim();
      if (text.length > 0) slots.push({ role, text });
    } catch { /* skip */ }
  }
  return slots;
}

/**
 * Load the shared plan for a task. Concatenates every plan slot
 * (unscoped + per-role) into one markdown block. Returns `null`
 * when no slot has content (planner hasn't run, or all files empty).
 *
 * When multiple slots are present, each one is prefixed with a clear
 * `### From <role>` header so downstream coders know which planner
 * owned which section. The unscoped `plan.md` (when present alongside
 * per-role files) is labeled `### From planner (legacy / shared)`.
 */
export function loadSharedPlan(taskId: string): string | null {
  const slots = readPlanSlots(taskId);
  if (slots.length === 0) return null;

  let merged: string;
  if (slots.length === 1 && slots[0].role === null) {
    // Single unscoped plan — emit verbatim so legacy single-planner
    // tasks are byte-for-byte unchanged.
    merged = slots[0].text;
  } else {
    const parts: string[] = [];
    for (const slot of slots) {
      const heading =
        slot.role === null
          ? "### From planner (legacy / shared)"
          : `### From ${slot.role}`;
      parts.push(`${heading}\n\n${slot.text}`);
    }
    merged = parts.join("\n\n---\n\n");
  }

  // Apply the cap to the FINAL merged output. A long task with 3+
  // planners would otherwise blow through the 16 KB ceiling on the
  // child prompt even though each individual planner stayed within
  // its own ~80-line budget.
  const buf = Buffer.from(merged, "utf8");
  if (buf.byteLength <= SHARED_PLAN_CAP_BYTES) return merged;
  const truncated = buf.subarray(0, SHARED_PLAN_CAP_BYTES).toString("utf8");
  return (
    truncated +
    "\n\n…(bridge: plan.md truncated at 16 KB cap — narrow your slice via a focused planner re-dispatch if more detail is needed)"
  );
}

/** Test-only — surface the raw slot list so unit tests can assert the merge logic. */
export function _readPlanSlotsForTest(taskId: string): PlanSlot[] {
  return readPlanSlots(taskId);
}

/** Test-only — read a single per-role slot by filename. */
export function _slotBasename(path: string): string {
  return basename(path);
}
