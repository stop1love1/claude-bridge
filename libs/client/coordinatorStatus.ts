import type { Run, RunStatus } from "./types";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled", "stale"]);

export function isCoordinatorOrchestrating(args: {
  coordinator: Run;
  runs: readonly Run[];
}): boolean {
  if (!TERMINAL.has(args.coordinator.status)) return false;
  return args.runs.some(
    (r) =>
      r.sessionId !== args.coordinator.sessionId &&
      (r.status === "queued" || r.status === "running"),
  );
}
