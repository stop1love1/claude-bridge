import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_MD, BRIDGE_ROOT, BRIDGE_STATE_DIR, SESSIONS_DIR } from "./paths";
import {
  createMeta,
  emitTaskSection,
  readMeta,
  withTaskLock,
  writeMeta,
  type Meta,
} from "./meta";
import { resolveRepoCwd } from "./repos";
import { projectDirFor } from "./sessions";
import { killChild } from "./spawnRegistry";
import {
  generateTaskId as generateIdFromList,
  isValidTaskId,
  SECTION_STATUS,
  type Task,
  type TaskSection,
} from "./tasks";

/**
 * Resolve a task's sessions directory after asserting the id is in the
 * canonical `t_YYYYMMDD_NNN` format. Rejects anything that could escape
 * `SESSIONS_DIR` — separators, parent traversal, drive letters, null
 * bytes — so callers don't have to validate at every entry point.
 */
function safeSessionDir(id: string): string | null {
  if (!isValidTaskId(id)) return null;
  return join(SESSIONS_DIR, id);
}

/**
 * meta.json is now the source of truth for tasks. This module replaces
 * the old `tasks.md` round-trip with a per-task file under
 * `sessions/<task-id>/meta.json`.
 */

function metaToTask(meta: Meta): Task {
  return {
    id: meta.taskId,
    date: meta.createdAt.slice(0, 10),
    title: meta.taskTitle,
    body: meta.taskBody,
    status: meta.taskStatus,
    section: meta.taskSection,
    checked: meta.taskChecked,
    app: meta.taskApp ?? null,
  };
}

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function listMetaIds(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR).filter((id) => {
    try {
      return statSync(join(SESSIONS_DIR, id)).isDirectory();
    } catch {
      return false;
    }
  });
}

export function listTasks(): Task[] {
  const tasks: Task[] = [];
  for (const id of listMetaIds()) {
    const meta = readMeta(join(SESSIONS_DIR, id));
    if (meta) tasks.push(metaToTask(meta));
  }
  // Newest first — `createdAt` is an ISO string so lexical sort works.
  tasks.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return tasks;
}

export function getTask(id: string): Task | null {
  const dir = safeSessionDir(id);
  if (!dir) return null;
  const meta = readMeta(dir);
  return meta ? metaToTask(meta) : null;
}

/**
 * Reverse-lookup a task by any of its session ids. Used by the message
 * route to detect when the user is chatting in a task that's been
 * marked done — we re-open it (untick + back to DOING) so a follow-up
 * conversation isn't trapped inside a "completed" pill.
 *
 * Linear scan over `listMetaIds`; messages are user-driven so this
 * runs at human cadence, not per-tool-call.
 */
export function findTaskBySessionId(sessionId: string): Task | null {
  for (const id of listMetaIds()) {
    const meta = readMeta(join(SESSIONS_DIR, id));
    if (!meta) continue;
    if (meta.runs.some((r) => r.sessionId === sessionId)) {
      return metaToTask(meta);
    }
  }
  return null;
}

export function generateTaskId(now: Date): string {
  return generateIdFromList(now, listMetaIds());
}

export function createTask(input: {
  title: string;
  body: string;
  app?: string | null;
}): Task {
  ensureSessionsDir();
  const now = new Date();
  const id = generateTaskId(now);
  const dir = join(SESSIONS_DIR, id);
  const taskApp = input.app && input.app.trim() ? input.app.trim() : null;
  createMeta(dir, {
    taskId: id,
    taskTitle: input.title,
    taskBody: input.body,
    taskStatus: "todo",
    taskSection: "TODO",
    taskChecked: false,
    taskApp,
    createdAt: now.toISOString(),
  });
  return {
    id,
    date: now.toISOString().slice(0, 10),
    title: input.title,
    body: input.body,
    status: "todo",
    section: "TODO",
    checked: false,
    app: taskApp,
  };
}

type TaskPatch = Partial<Pick<Task, "title" | "body" | "section" | "status" | "checked">>;

export async function updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
  const dir = safeSessionDir(id);
  if (!dir) return null;
  // Acquired the per-task mutex here too so a UI title/section edit
  // racing a child's appendRun (or any other run-row mutator) can't
  // silently overwrite the just-appended row. meta.runs and the task
  // header live in the same JSON, so the read-modify-write window
  // must be serialized against everything in lib/meta.ts that
  // takes the same lock.
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return null;
    const prevSection = meta.taskSection;
    if (patch.title !== undefined) meta.taskTitle = patch.title;
    if (patch.body !== undefined) meta.taskBody = patch.body;
    if (patch.checked !== undefined) meta.taskChecked = patch.checked;
    if (patch.section !== undefined) {
      meta.taskSection = patch.section;
      meta.taskStatus = SECTION_STATUS[patch.section];
    } else if (patch.status !== undefined) {
      meta.taskStatus = patch.status;
    }
    writeMeta(dir, meta);
    // Surface section changes (TODO/DOING/BLOCKED → DONE etc.) on the
    // meta event bus so the Telegram notifier can ping when the user
    // ticks the "complete" checkbox in the UI. The emitter no-ops
    // when prevSection === nextSection, so a pure title/body edit
    // doesn't fire a spurious notification.
    emitTaskSection({
      taskId: id,
      prevSection,
      nextSection: meta.taskSection,
      taskTitle: meta.taskTitle,
      taskChecked: meta.taskChecked,
    });
    return metaToTask(meta);
  });
}

export interface DeleteTaskResult {
  ok: boolean;
  sessionsDeleted: number;
  sessionsFailed: number;
}

/**
 * Delete a task plus its linked Claude session files. We enumerate
 * runs from meta.json BEFORE removing the dir, then for each run:
 *   1. SIGTERM any still-running child (best-effort) so we don't fight
 *      file locks on Windows
 *   2. Remove `<projectDir>/<sessionId>.jsonl` under the run's repo
 *   3. Remove any per-session settings under `.bridge-state/<sessionId>/`
 *
 * Failures on individual sessions are counted but don't abort the task
 * deletion — the user's intent is "make this task go away", and a stuck
 * .jsonl shouldn't trap the meta.json forever.
 */
export function deleteTask(id: string): DeleteTaskResult {
  const dir = safeSessionDir(id);
  if (!dir || !existsSync(dir)) return { ok: false, sessionsDeleted: 0, sessionsFailed: 0 };

  let sessionsDeleted = 0;
  let sessionsFailed = 0;

  const meta = readMeta(dir);
  if (meta && meta.runs.length > 0) {
    let bridgeMd = "";
    try { bridgeMd = readFileSync(BRIDGE_MD, "utf8"); } catch { /* ignore */ }

    for (const run of meta.runs) {
      try { killChild(run.sessionId); } catch { /* best-effort */ }

      // Per-session settings dir (free-session shape — harmless if it
      // doesn't exist for task-scoped runs).
      const stateDir = join(BRIDGE_STATE_DIR, run.sessionId);
      if (existsSync(stateDir)) {
        try { rmSync(stateDir, { recursive: true, force: true }); }
        catch { /* ignore */ }
      }

      const cwd = bridgeMd ? resolveRepoCwd(bridgeMd, BRIDGE_ROOT, run.repo) : null;
      if (!cwd) continue;
      const file = join(projectDirFor(cwd), `${run.sessionId}.jsonl`);
      if (!existsSync(file)) continue;
      try {
        rmSync(file, { force: true });
        sessionsDeleted += 1;
      } catch {
        sessionsFailed += 1;
      }
    }
  }

  rmSync(dir, { recursive: true, force: true });
  return { ok: true, sessionsDeleted, sessionsFailed };
}

export function isValidSection(section: string): section is TaskSection {
  return Object.prototype.hasOwnProperty.call(SECTION_STATUS, section);
}

/**
 * Re-tag every task whose `taskApp` points at `oldName` so it points at
 * `newName` instead. Used by the apps-rename API route to keep the
 * task → app association intact across renames. Returns the count of
 * meta files that were rewritten.
 *
 * Best-effort: a single corrupt meta.json doesn't abort the migration —
 * we skip it and continue. The caller reports the count back to the UI
 * as a toast so the operator can spot a partial cascade.
 */
export async function migrateTaskApp(oldName: string, newName: string): Promise<number> {
  if (oldName === newName) return 0;
  let migrated = 0;
  for (const id of listMetaIds()) {
    const dir = join(SESSIONS_DIR, id);
    // Each task gets its own lock acquisition: a parallel `Promise.all`
    // would block on the same dir's queue anyway, and a sequential loop
    // keeps the error handling per-task simple. The lock is the same
    // one appendRun/updateRun take, so a child agent's run-row mutate
    // running against the same task can't trample our header rewrite.
    const ok = await withTaskLock(dir, () => {
      const meta = readMeta(dir);
      if (!meta) return false;
      if (meta.taskApp !== oldName) return false;
      meta.taskApp = newName;
      writeMeta(dir, meta);
      return true;
    }).catch((err) => {
      console.error("migrateTaskApp: failed to rewrite", id, err);
      return false;
    });
    if (ok) migrated += 1;
  }
  return migrated;
}
