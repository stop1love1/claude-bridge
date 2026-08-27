import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SESSIONS_DIR } from "./paths";

export const SHARED_PLAN_CAP_BYTES = 16 * 1024;

export function sharedPlanPath(taskId: string): string {
  return join(SESSIONS_DIR, taskId, "plan.md");
}

export function rolePlanPath(taskId: string, role: string): string {
  return join(SESSIONS_DIR, taskId, `plan-${role}.md`);
}

interface PlanSlot {
  role: string | null;
  text: string;
}

function readPlanSlots(taskId: string): PlanSlot[] {
  const dir = join(SESSIONS_DIR, taskId);
  if (!existsSync(dir)) return [];
  const slots: PlanSlot[] = [];

  const unscoped = sharedPlanPath(taskId);
  if (existsSync(unscoped)) {
    try {
      const text = readFileSync(unscoped, "utf8").trim();
      if (text.length > 0) slots.push({ role: null, text });
    } catch { }
  }

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
    } catch { }
  }
  return slots;
}

export function loadSharedPlan(taskId: string): string | null {
  const slots = readPlanSlots(taskId);
  if (slots.length === 0) return null;

  let merged: string;
  if (slots.length === 1 && slots[0].role === null) {
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

  const buf = Buffer.from(merged, "utf8");
  if (buf.byteLength <= SHARED_PLAN_CAP_BYTES) return merged;
  const truncated = buf.subarray(0, SHARED_PLAN_CAP_BYTES).toString("utf8");
  return (
    truncated +
    "\n\n…(bridge: plan.md truncated at 16 KB cap — narrow your slice via a focused planner re-dispatch if more detail is needed)"
  );
}

export function _readPlanSlotsForTest(taskId: string): PlanSlot[] {
  return readPlanSlots(taskId);
}

export function _slotBasename(path: string): string {
  return basename(path);
}
