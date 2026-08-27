import type { RunStatus } from "./types";

export type DerivedStatus = "spawning" | "running" | "failed" | "done" | "idle" | "completed";

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
