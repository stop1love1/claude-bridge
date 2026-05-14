/**
 * Derive a UI-only "orchestrating" badge for the coordinator row.
 *
 * The coordinator's `Run.status` reflects ITS process state — `done`
 * the moment its turn exits cleanly, even if it just dispatched a
 * fresh child that's still running. Operators reading the dashboard
 * read that as "task is finished" and get confused when a child row
 * is still pulsing RUNNING.
 *
 * This helper returns true iff:
 *   - the coordinator's run is in a terminal state (done / failed /
 *     stale) — a literal RUNNING coordinator already conveys activity
 *     and doesn't need the derived badge
 *   - AND there's at least one OTHER run in `runs[]` that's still
 *     queued / running — i.e. orchestration is in flight via a child
 *     even though the coordinator's process has stepped out
 *
 * The auto-nudge subscriber (`libs/coordinatorNudge.ts`) eventually
 * resumes the coordinator when those children settle, which flips its
 * status back to running for that turn — so this badge is bounded:
 * it shows during the gap between "coordinator dispatched + exited"
 * and "all dispatched children settled."
 */
import type { Run, RunStatus } from "./types";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "stale"]);

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
