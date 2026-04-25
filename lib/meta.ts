import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";
import type { TaskStatus, TaskSection } from "./tasks";

/**
 * Write `meta.json` atomically: stage the new contents in a sibling
 * tempfile, then `rename` over the destination. `rename` is atomic on
 * POSIX and atomic-on-success on NTFS, so a crash mid-write leaves
 * either the old file or the new one — never a half-written one. The
 * temp file is also a per-call random suffix so two concurrent writes
 * can't trample each other's staging.
 */
function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = filePath.slice(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")));
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the staged file before re-throwing.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stale";

/**
 * A run is a single Claude Code session the coordinator spawned for a task.
 * `role` is an arbitrary label chosen by the coordinator ("coordinator",
 * "coder", "reviewer", "researcher", "fixer", ...) — not a closed enum.
 * `repo` is the folder name (from BRIDGE.md Repos table) the session runs
 * against; for orchestration runs it's the bridge folder's own basename
 * (`BRIDGE_FOLDER` from `lib/paths.ts`).
 * `parentSessionId` (Phase B+) is the coordinator session UUID that
 * spawned this run via `POST /api/tasks/<id>/agents`. `null` / absent
 * means the run was spawned directly by the bridge (the coordinator
 * itself) or by a pre-Phase-B path. Phase C uses this to draw the
 * agent tree.
 */
export interface Run {
  sessionId: string;
  role: string;
  repo: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  parentSessionId?: string | null;
  /**
   * Phase D auto-retry: when the bridge auto-spawns a fix agent because
   * a child failed, the new run carries the failed run's sessionId here
   * so the AgentTree can group siblings under the same parent visually.
   * `null` / absent means this run is not a retry.
   */
  retryOf?: string | null;
}

/**
 * Per-task runtime state. The full task definition (title, body, status,
 * section, checked) lives here too — meta.json is the source of truth
 * for tasks, replacing the old `tasks.md` round-trip.
 */
export interface Meta {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: TaskStatus;
  taskSection: TaskSection;
  taskChecked: boolean;
  /**
   * Target app name from the apps registry (`sessions/init.md`).
   * `null` / absent means "auto" — let the coordinator's heuristic
   * decide which repo to dispatch to based on the task body.
   */
  taskApp?: string | null;
  createdAt: string;
  runs: Run[];
}

const FILE = "meta.json";

/**
 * Lifecycle event payload emitted whenever a task's meta.json mutates
 * via this module's helpers. Phase C's per-task SSE route subscribes to
 * this and forwards `spawned` / `done` / `failed` events to the UI so
 * the polling fallback can drop from 1.5s → 5s.
 *
 * - `kind`:
 *   - `"spawned"` — appendRun: brand-new run (`prevStatus === undefined`)
 *   - `"transition"` — updateRun: status changed (prev → next)
 *   - `"updated"` — updateRun without a status change (e.g. role rename)
 *   - `"writeMeta"` — full writeMeta (no per-run signal — task header changed)
 *   - `"retried"` — Phase D: auto-retry kicked off for a failed child;
 *     `run` is the NEW retry run, `retryOf` is the failed run's sessionId
 */
export interface MetaChangeEvent {
  taskId: string;
  kind: "spawned" | "transition" | "updated" | "writeMeta" | "retried";
  sessionId?: string;
  run?: Run;
  prevStatus?: RunStatus;
  retryOf?: string;
}

interface MetaEvents {
  emitter: EventEmitter;
}

// HMR-safe global stash, same trick as permissionStore / spawnRegistry.
const G = globalThis as unknown as { __bridgeMetaEvents?: MetaEvents };
const events: MetaEvents =
  G.__bridgeMetaEvents ?? { emitter: (() => { const e = new EventEmitter(); e.setMaxListeners(0); return e; })() };
G.__bridgeMetaEvents = events;

export function subscribeMeta(
  taskId: string,
  cb: (ev: MetaChangeEvent) => void,
): () => void {
  const handler = (ev: MetaChangeEvent) => {
    if (ev.taskId === taskId) cb(ev);
  };
  events.emitter.on("meta:changed", handler);
  return () => events.emitter.off("meta:changed", handler);
}

/**
 * Resolve a task id from the sessions directory we were handed. Every
 * call site uses `join(SESSIONS_DIR, taskId)`, so the basename is the
 * task id. Cheap and avoids threading the id through every helper.
 */
function taskIdFromDir(dir: string): string {
  return basename(dir);
}

function emit(ev: MetaChangeEvent): void {
  // setImmediate-equivalent: emit synchronously so subscribers see the
  // mutation in the same tick. SSE consumers buffer their own writes.
  events.emitter.emit("meta:changed", ev);
}

/**
 * Phase D: fire a `retried` event on the per-task SSE stream after the
 * bridge auto-spawns a fix agent. The `appendRun` call for the new
 * retry run already fires `spawned`; this is a follow-up event the UI
 * can use to draw the retry-of arrow without scanning every run.
 */
export function emitRetried(taskId: string, retryRun: Run, retryOf: string): void {
  emit({
    taskId,
    kind: "retried",
    sessionId: retryRun.sessionId,
    run: retryRun,
    retryOf,
  });
}

export function createMeta(dir: string, header: Omit<Meta, "runs">): void {
  mkdirSync(dir, { recursive: true });
  const meta: Meta = { ...header, runs: [] };
  atomicWriteJson(join(dir, FILE), meta);
  emit({ taskId: taskIdFromDir(dir), kind: "writeMeta" });
}

export function readMeta(dir: string): Meta | null {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Meta;
}

export function writeMeta(dir: string, meta: Meta): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(join(dir, FILE), meta);
  emit({ taskId: taskIdFromDir(dir), kind: "writeMeta" });
}

export function appendRun(dir: string, run: Run): void {
  const meta = readMeta(dir);
  if (!meta) throw new Error(`meta.json missing at ${dir}`);
  meta.runs.push(run);
  atomicWriteJson(join(dir, FILE), meta);
  emit({
    taskId: taskIdFromDir(dir),
    kind: "spawned",
    sessionId: run.sessionId,
    run,
  });
}

export function updateRun(dir: string, sessionId: string, patch: Partial<Run>): void {
  const meta = readMeta(dir);
  if (!meta) throw new Error(`meta.json missing at ${dir}`);
  const run = meta.runs.find((r) => r.sessionId === sessionId);
  if (!run) throw new Error(`run ${sessionId} not found`);
  const prevStatus = run.status;
  Object.assign(run, patch);
  atomicWriteJson(join(dir, FILE), meta);
  const statusChanged = patch.status !== undefined && patch.status !== prevStatus;
  emit({
    taskId: taskIdFromDir(dir),
    kind: statusChanged ? "transition" : "updated",
    sessionId,
    run: { ...run },
    prevStatus,
  });
}
