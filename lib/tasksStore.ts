import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_MD, BRIDGE_ROOT, BRIDGE_STATE_DIR, SESSIONS_DIR } from "./paths";
import { createMeta, readMeta, writeMeta, type Meta } from "./meta";
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

export function updateTask(id: string, patch: TaskPatch): Task | null {
  const dir = safeSessionDir(id);
  if (!dir) return null;
  const meta = readMeta(dir);
  if (!meta) return null;
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
  return metaToTask(meta);
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
