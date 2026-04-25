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
  /**
   * P2 verify chain: when an app has at least one `verify` command
   * configured (`bridge.json.apps[].verify`), the bridge runs the chain
   * after the child exits cleanly and persists the per-step results
   * here. Absent / null = chain didn't run (no commands configured, or
   * the run was a coordinator / unregistered repo).
   */
  verify?: RunVerify | null;
}

/**
 * P2 — outcome of the post-run verify chain. Steps are persisted in
 * declaration order (`format → lint → typecheck → test → build`), but
 * only the steps the app actually configured a command for appear here
 * (no skipped placeholder rows, to keep meta.json terse).
 */
export interface RunVerify {
  steps: RunVerifyStep[];
  /** True iff every step in `steps` exited 0. */
  passed: boolean;
  startedAt: string;
  endedAt: string;
  /** True if the bridge spawned a `-vretry` follow-up because of this. */
  retryScheduled?: boolean;
}

export interface RunVerifyStep {
  /** Canonical step name — matches the AppVerify field key. */
  name: "format" | "lint" | "typecheck" | "test" | "build";
  /** Exact command line the bridge ran via `sh -c` / `cmd /c`. */
  cmd: string;
  ok: boolean;
  /** Process exit code; `null` when the chain aborted (timeout, spawn error). */
  exitCode: number | null;
  durationMs: number;
  /**
   * Combined stdout+stderr, capped at the runner's outputCapBytes
   * (default 16 KB). Truncation marker appended when capped.
   */
  output: string;
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
 * CRIT-2: per-task-directory async mutex around the read-modify-write
 * helpers below (`appendRun`, `updateRun`, `applyManyRuns`). Without it,
 * two concurrent callers (e.g. coordinator spawning two children, or a
 * `link` POST racing the lifecycle hook) both observe the same
 * pre-mutation file, mutate, and atomically rename — the second write
 * silently overwrites the first, losing one run.
 *
 * The lock is keyed by absolute task dir. The atomic file rename inside
 * each helper still protects against partial writes; the lock just
 * serializes the read window so back-to-back writes can't trample each
 * other.
 *
 * Map-of-promises pattern: every call chains onto whatever the latest
 * pending operation for that dir is. The chain catches errors so a
 * failed op doesn't poison the queue for everyone behind it. We
 * best-effort GC the entry when the chain settles, but a tiny leak is
 * preferable to dropping the chain link mid-flight.
 *
 * Exported so other modules (e.g. `tasksStore.updateTask`,
 * `tasksStore.migrateTaskApp`) can serialize their own `readMeta →
 * mutate header → writeMeta` sequences against the run-row helpers
 * below. Without this, a UI title edit racing a child's appendRun
 * could silently drop the just-appended run.
 */
const writeQueues = new Map<string, Promise<unknown>>();
export async function withTaskLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = writeQueues.get(dir) ?? Promise.resolve();
  // Run regardless of whether `prev` resolved or rejected — one bad
  // operation must not strand later writes for the same task.
  const next: Promise<T> = prev.then(
    () => fn(),
    () => fn(),
  );
  // Stash a swallowed-error variant so the queue head can be awaited
  // without re-throwing prior failures into unrelated callers.
  const tail = next.catch(() => {});
  writeQueues.set(dir, tail);
  try {
    return await next;
  } finally {
    if (writeQueues.get(dir) === tail) writeQueues.delete(dir);
  }
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

export async function appendRun(dir: string, run: Run): Promise<void> {
  await withTaskLock(dir, () => {
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
  });
}

export async function updateRun(
  dir: string,
  sessionId: string,
  patch: Partial<Run>,
): Promise<void> {
  await withTaskLock(dir, () => {
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
  });
}

/**
 * H6: batched read-modify-write for callers that need to patch many
 * runs at once (e.g. `staleRunReaper` flipping every old `running` run
 * to `failed` in one pass). Doing this with a loop of `updateRun` calls
 * costs N lock cycles, N reads, and N atomic renames; this helper does
 * 1 read + N in-memory patches + 1 write under a single lock, while
 * still firing the same per-run `transition` / `updated` events so
 * existing SSE consumers (the events route forwarding `transition` to
 * the UI) keep working.
 *
 * Patches whose `sessionId` doesn't match any run in `meta.runs` are
 * silently skipped — the reaper is the primary caller and a run that
 * was deleted between the meta read and the patch list is a no-op,
 * not an error. Returns the post-write `Meta` for the caller's
 * convenience (the reaper hands it straight to the API response).
 */
export async function applyManyRuns(
  dir: string,
  patches: Array<{ sessionId: string; patch: Partial<Run> }>,
): Promise<Meta | null> {
  if (patches.length === 0) {
    return readMeta(dir);
  }
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return null;
    // Buffer per-run events and flush them only AFTER the atomic write
    // so SSE subscribers never observe a `transition` event for a row
    // that isn't yet on disk.
    const pending: MetaChangeEvent[] = [];
    let mutated = false;
    for (const { sessionId, patch } of patches) {
      const run = meta.runs.find((r) => r.sessionId === sessionId);
      if (!run) continue;
      // Review nit: skip patches that are a no-op against the
      // current on-disk state. Primary case: the reaper's outer
      // `readMeta` saw the run as `running`, but between that read
      // and our locked re-read another writer flipped it to
      // `failed` (e.g. lifecycle hook firing). Without this guard
      // we'd emit a spurious `"updated"` SSE event and rewrite
      // identical bytes.
      const prevStatus = run.status;
      const statusUnchanged =
        patch.status === undefined || patch.status === prevStatus;
      const noOtherFields = Object.keys(patch).every(
        (k) => k === "status" || (run as unknown as Record<string, unknown>)[k] === (patch as Record<string, unknown>)[k],
      );
      if (statusUnchanged && noOtherFields) continue;
      Object.assign(run, patch);
      mutated = true;
      const statusChanged = !statusUnchanged;
      pending.push({
        taskId: taskIdFromDir(dir),
        kind: statusChanged ? "transition" : "updated",
        sessionId,
        run: { ...run },
        prevStatus,
      });
    }
    if (mutated) {
      atomicWriteJson(join(dir, FILE), meta);
      for (const ev of pending) emit(ev);
    }
    return meta;
  });
}

/**
 * H7: helper for the DELETE /api/sessions/[sessionId] handler — filter
 * a session out of the task's runs under the same lock that protects
 * appendRun/updateRun. Returns true if the session was found and
 * removed (so the caller can track which tasks were affected), false
 * if the meta is missing or the session wasn't linked to this task.
 */
export async function removeSessionFromTask(
  dir: string,
  sessionId: string,
): Promise<boolean> {
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return false;
    const before = meta.runs.length;
    meta.runs = meta.runs.filter((r) => r.sessionId !== sessionId);
    if (meta.runs.length === before) return false;
    atomicWriteJson(join(dir, FILE), meta);
    emit({ taskId: taskIdFromDir(dir), kind: "writeMeta" });
    return true;
  });
}
