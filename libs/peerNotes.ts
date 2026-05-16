/**
 * Peer notes — shared scratch-pad for cross-cutting observations
 * between sibling agents on the same task.
 *
 * The problem this solves: when the coordinator dispatches multiple
 * agents in parallel (e.g. `planner-api` + `planner-ui`, or a
 * `coder` while a `ui-tester` is probing), siblings can't see each
 * other's discoveries in real time. They each re-derive context,
 * sometimes inventing different contracts, and the operator only
 * learns about the divergence when the coordinator aggregates
 * reports at the end.
 *
 * Mechanism: every agent's wrapped prompt now includes a one-line
 * instruction to append cross-cutting observations to
 * `sessions/<task-id>/notes.md` (a single shared file). At spawn
 * time the bridge injects whatever notes already exist into the
 * child's prompt as a `## Peer notes` section so a later-spawning
 * sibling sees what earlier siblings learned.
 *
 * Append-only (children should never edit / delete prior entries),
 * timestamp-prefixed, capped to keep the file from growing
 * unbounded. Failures fail-soft to null/empty — peer notes are an
 * enrichment, never a hard requirement.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";

/**
 * Hard cap on the size injected into a child prompt. Mirrors the
 * shared-plan cap; both compete for the same "context bloat" budget,
 * but a hot task with many siblings can blow this through if
 * unchecked.
 */
export const PEER_NOTES_CAP_BYTES = 12 * 1024;

/** Canonical path of the shared scratch-pad. */
export function peerNotesPath(taskId: string): string {
  return join(SESSIONS_DIR, taskId, "notes.md");
}

/**
 * Load the current peer-notes content for a task. Returns `null`
 * when no file exists yet (first agent on the task) or when it's
 * empty after trim. The caller (agents route) injects the result
 * as `## Peer notes` into the child prompt.
 */
export function loadPeerNotes(taskId: string): string | null {
  const p = peerNotesPath(taskId);
  if (!existsSync(p)) return null;
  try {
    const buf = readFileSync(p);
    const text = buf
      .subarray(0, PEER_NOTES_CAP_BYTES)
      .toString("utf8")
      .trim();
    if (text.length === 0) return null;
    if (buf.byteLength > PEER_NOTES_CAP_BYTES) {
      return (
        text +
        "\n\n…(bridge: notes.md truncated at 12 KB cap — older entries are still on disk; read the file directly if you need them)"
      );
    }
    return text;
  } catch {
    return null;
  }
}
