import type { RunStatus } from "./types";

/**
 * Single source of truth for run / task status pill colors. Both
 * TaskGrid (task-level derived status) and AgentTree (per-run status)
 * import from here so a status colour change happens in one place.
 *
 * `DerivedStatus` is the task-card flavour: it adds "spawning",
 * "idle", and "completed" which are computed from a Meta + Task pair,
 * not a single Run. `completed` reflects the user-confirmed checkbox
 * (`task.checked`) and overrides the run-derived state so the list
 * stays in sync with the "Completed" label shown in TaskDetail.
 */
export type DerivedStatus = "spawning" | "running" | "failed" | "done" | "idle" | "completed";

export interface StatusPill {
  label: string;
  cls: string;
  pulse: boolean;
}

/**
 * Colour + pulse for a "task-level" derived status (used by TaskGrid).
 */
export const STATUS_PILL: Record<DerivedStatus, StatusPill> = {
  spawning: { label: "spawning", cls: "bg-info/20 text-info", pulse: true },
  running: { label: "running", cls: "bg-warning/20 text-warning", pulse: true },
  failed: { label: "failed", cls: "bg-destructive/20 text-destructive", pulse: false },
  done: { label: "done", cls: "bg-success/20 text-success", pulse: false },
  idle: { label: "idle", cls: "bg-fg-dim/15 text-fg-dim", pulse: false },
  completed: { label: "completed", cls: "bg-success/40 text-success", pulse: false },
};

/**
 * Colour + pulse for an individual run's status. `queued` and `stale`
 * are run-only (no task-level equivalent), so we surface them here.
 */
export const RUN_STATUS_PILL: Record<RunStatus, StatusPill> = {
  queued: { label: "queued", cls: "bg-info/20 text-info", pulse: false },
  running: { label: "running", cls: "bg-warning/20 text-warning", pulse: true },
  done: { label: "done", cls: "bg-success/20 text-success", pulse: false },
  failed: { label: "failed", cls: "bg-destructive/20 text-destructive", pulse: false },
  stale: { label: "stale", cls: "bg-fg-dim/20 text-fg-dim", pulse: false },
};
