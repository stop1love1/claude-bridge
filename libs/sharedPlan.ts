/**
 * Shared plan loader. Reads `sessions/<task-id>/plan.md` when a planner
 * agent has drafted one, and returns the contents (capped) so the agents
 * route can inject it into every downstream child's prompt as `## Shared
 * plan (from planner)`.
 *
 * Soft fail by design: missing file, unreadable file, empty file all
 * resolve to `null`. The plan is an enrichment, not a hard requirement
 * — children have always been able to run without it, and tasks that
 * never spawn a planner should look identical to the pre-planner world.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";

/**
 * Hard cap on plan.md size injected into a child prompt. The planner
 * playbook tells the agent to keep `plan.md` under ~80 lines; this cap
 * is a defensive ceiling against a runaway planner blowing out every
 * downstream child's context window.
 */
export const SHARED_PLAN_CAP_BYTES = 16 * 1024;

export function sharedPlanPath(taskId: string): string {
  return join(SESSIONS_DIR, taskId, "plan.md");
}

/**
 * Load the shared plan for a task. Returns `null` when no plan exists
 * yet (the planner hasn't run, or never will for this task) or when the
 * file is empty after trimming.
 */
export function loadSharedPlan(taskId: string): string | null {
  const p = sharedPlanPath(taskId);
  if (!existsSync(p)) return null;
  try {
    const buf = readFileSync(p);
    const text = buf.subarray(0, SHARED_PLAN_CAP_BYTES).toString("utf8").trim();
    if (text.length === 0) return null;
    if (buf.byteLength > SHARED_PLAN_CAP_BYTES) {
      return text + "\n\n…(bridge: plan.md truncated at 16 KB cap — refresh via planner if more detail is needed)";
    }
    return text;
  } catch {
    return null;
  }
}
