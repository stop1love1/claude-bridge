/**
 * Cross-task run census.
 *
 * The scheduler's auto-queue pump needs to know "how many tasks are
 * currently being worked" before it dispatches another, so it can honor
 * the global concurrency cap. There is no in-memory counter for this —
 * each task's `meta.runs` is independent — so we scan every
 * `sessions/<id>/meta.json` once per census.
 *
 * Cheap enough for the scheduler's ~30s tick: readMeta is cached
 * (per-dir TTL) and the file count is in the hundreds at most. We count a
 * task as "busy" when it has at least one LIVE (running/queued)
 * COORDINATOR run — that's the unit the cap governs, since one
 * coordinator fans out its own children.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";
import { readMeta } from "./meta";
import { isValidTaskId } from "./tasks";
import { parseRole } from "./retryLadder";

const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "queued"]);

export interface RunCensus {
  /** Task ids that currently have a live coordinator run. */
  busyTaskIds: string[];
  /** Convenience: busyTaskIds.length — the number the cap is compared to. */
  liveCoordinatorTasks: number;
  /** Total live runs of ANY role across all tasks (for the status panel). */
  liveRuns: number;
}

function listTaskDirs(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR).filter((id) => {
    if (!isValidTaskId(id)) return false;
    try {
      return statSync(join(SESSIONS_DIR, id)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Scan all tasks and tally live runs. A "busy" task is one with a live
 * coordinator (role parses to baseRole `coordinator`); the auto-queue
 * pump compares `liveCoordinatorTasks` against the configured cap.
 */
export function takeRunCensus(): RunCensus {
  const busyTaskIds: string[] = [];
  let liveRuns = 0;

  for (const id of listTaskDirs()) {
    const meta = readMeta(join(SESSIONS_DIR, id));
    if (!meta) continue;
    let hasLiveCoordinator = false;
    for (const run of meta.runs) {
      if (!LIVE_STATUSES.has(run.status)) continue;
      liveRuns += 1;
      if (parseRole(run.role).baseRole === "coordinator") {
        hasLiveCoordinator = true;
      }
    }
    if (hasLiveCoordinator) busyTaskIds.push(id);
  }

  return {
    busyTaskIds,
    liveCoordinatorTasks: busyTaskIds.length,
    liveRuns,
  };
}
