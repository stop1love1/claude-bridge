import type { Meta, RunStatus, Task } from "./types";

export type DerivedStatus =
  | "spawning"
  | "running"
  | "failed"
  | "done"
  | "cancelled"
  | "stale"
  | "idle"
  | "completed";

export interface StatusPill {
  label: string;
  cls: string;
  pulse: boolean;
}

export const STATUS_PILL: Record<DerivedStatus, StatusPill> = {
  spawning: { label: "spawning", cls: "bg-info/20 text-info", pulse: true },
  running: { label: "running", cls: "bg-warning/20 text-warning", pulse: true },
  failed: { label: "failed", cls: "bg-destructive/20 text-destructive", pulse: false },
  done: { label: "done", cls: "bg-success/20 text-success", pulse: false },
  cancelled: { label: "cancelled", cls: "bg-fg-dim/20 text-fg-dim", pulse: false },
  stale: { label: "stale", cls: "bg-fg-dim/20 text-fg-dim", pulse: false },
  idle: { label: "idle", cls: "bg-fg-dim/15 text-fg-dim", pulse: false },
  completed: { label: "completed", cls: "bg-success/40 text-success", pulse: false },
};

export const RUN_STATUS_PILL: Record<RunStatus, StatusPill> = {
  queued: { label: "queued", cls: "bg-info/20 text-info", pulse: false },
  running: { label: "running", cls: "bg-warning/20 text-warning", pulse: true },
  done: { label: "done", cls: "bg-success/20 text-success", pulse: false },
  failed: { label: "failed", cls: "bg-destructive/20 text-destructive", pulse: false },
  cancelled: { label: "cancelled", cls: "bg-fg-dim/20 text-fg-dim", pulse: false },
  stale: { label: "stale", cls: "bg-fg-dim/20 text-fg-dim", pulse: false },
};

/** A task with no runs yet is "spawning" for this long after creation. */
const SPAWN_GRACE_MS = 20_000;

/**
 * Collapse a task's run list into the single pill the board shows.
 *
 * Ladder: completed (user ticked) > spawning > running > coordinator
 * cancelled/stale > failed > done > idle. A killed or reaped coordinator is
 * surfaced by name — before this it fell through to "idle", which is the
 * same label a task that was never dispatched gets, so a task parked in
 * DOING after the operator hit Stop looked indistinguishable from one the
 * bridge had not touched.
 */
export function deriveTaskStatus(
  task: Pick<Task, "checked">,
  meta: Pick<Meta, "runs" | "createdAt"> | undefined,
  now: number = Date.now(),
): DerivedStatus {
  if (task.checked) return "completed";
  if (!meta) return "spawning";
  const runs = meta.runs ?? [];
  const createdMs = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
  const fresh = createdMs > 0 && now - createdMs < SPAWN_GRACE_MS;
  if (runs.length === 0) return fresh ? "spawning" : "idle";
  if (runs.some((r) => r.status === "running")) return "running";
  if (runs.some((r) => r.status === "queued")) return "spawning";
  const lastCoordinator = [...runs].reverse().find((r) => r.role === "coordinator");
  if (lastCoordinator?.status === "cancelled") return "cancelled";
  if (lastCoordinator?.status === "stale") return "stale";
  if (runs.some((r) => r.status === "failed")) return "failed";
  if (runs.some((r) => r.status === "done")) return "done";
  return "idle";
}
