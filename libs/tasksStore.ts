import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_ROOT, BRIDGE_STATE_DIR, SESSIONS_DIR, readBridgeMd } from "./paths";
import {
  createMeta,
  emitTaskSection,
  readMeta,
  subscribeMetaAll,
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

function safeSessionDir(id: string): string | null {
  if (!isValidTaskId(id)) return null;
  return join(SESSIONS_DIR, id);
}


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
    origin: meta.origin ?? "manual",
    workflowId: meta.workflowId ?? null,
    effort: meta.taskEffort ?? null,
    intakeStatus: meta.intake?.status ?? null,
  };
}

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function listMetaIds(): string[] {
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

const LIST_TASKS_TTL_MS = 1000;
let listTasksCache: { value: Task[]; expires: number } | null = null;

let sessionIndex: Map<string, string> | null = null;

subscribeMetaAll((ev) => {
  listTasksCache = null;
  if (!sessionIndex) return;
  switch (ev.kind) {
    case "spawned":
    case "retried":
      if (ev.sessionId) sessionIndex.set(ev.sessionId, ev.taskId);
      return;
    case "transition":
    case "updated":
    case "task-section":
      return;
    case "writeMeta":
      return;
  }
});

function buildSessionIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  for (const id of listMetaIds()) {
    const meta = readMeta(join(SESSIONS_DIR, id));
    if (!meta) continue;
    for (const run of meta.runs) {
      idx.set(run.sessionId, meta.taskId);
    }
  }
  return idx;
}

export function listTasks(): Task[] {
  const now = Date.now();
  if (listTasksCache && listTasksCache.expires > now) {
    return [...listTasksCache.value];
  }
  const tasks: Task[] = [];
  for (const id of listMetaIds()) {
    const meta = readMeta(join(SESSIONS_DIR, id));
    if (meta) tasks.push(metaToTask(meta));
  }
  tasks.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  listTasksCache = { value: tasks, expires: now + LIST_TASKS_TTL_MS };
  return [...tasks];
}

export function getTask(id: string): Task | null {
  const dir = safeSessionDir(id);
  if (!dir) return null;
  const meta = readMeta(dir);
  return meta ? metaToTask(meta) : null;
}

export function findTaskBySessionId(sessionId: string): Task | null {
  if (!sessionIndex) sessionIndex = buildSessionIndex();
  const taskId = sessionIndex.get(sessionId);
  if (!taskId) return null;
  return getTask(taskId);
}

export function generateTaskId(now: Date): string {
  return generateIdFromList(now, listMetaIds());
}

export function createTask(input: {
  title: string;
  body: string;
  app?: string | null;
  origin?: "manual" | "cron" | "pipeline";
  workflowId?: string | null;
  effort?: Task["effort"];
}): Task {
  ensureSessionsDir();
  const now = new Date();
  const id = generateTaskId(now);
  const dir = join(SESSIONS_DIR, id);
  const taskApp = input.app && input.app.trim() ? input.app.trim() : null;
  const origin = input.origin ?? "manual";
  const workflowId = input.workflowId ?? null;
  const taskEffort = input.effort ?? null;
  createMeta(dir, {
    taskId: id,
    taskTitle: input.title,
    taskBody: input.body,
    taskStatus: "todo",
    taskSection: "TODO",
    taskChecked: false,
    taskApp,
    taskEffort,
    createdAt: now.toISOString(),
    origin,
    workflowId,
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
    origin,
    workflowId,
    effort: taskEffort,
  };
}

type TaskPatch = Partial<Pick<Task, "title" | "body" | "section" | "status" | "checked">>;

export async function updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
  const dir = safeSessionDir(id);
  if (!dir) return null;
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

export async function deleteTask(id: string): Promise<DeleteTaskResult> {
  const dir = safeSessionDir(id);
  if (!dir || !existsSync(dir)) return { ok: false, sessionsDeleted: 0, sessionsFailed: 0 };

  return withTaskLock(dir, () => {
    let sessionsDeleted = 0;
    let sessionsFailed = 0;

    const meta = readMeta(dir);
    if (meta && meta.runs.length > 0) {
      const bridgeMd = readBridgeMd();

      for (const run of meta.runs) {
        try { killChild(run.sessionId); } catch { }

        const stateDir = join(BRIDGE_STATE_DIR, run.sessionId);
        if (existsSync(stateDir)) {
          try { rmSync(stateDir, { recursive: true, force: true }); }
          catch { }
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
    if (sessionIndex && meta) {
      for (const run of meta.runs) sessionIndex.delete(run.sessionId);
    }
    return { ok: true, sessionsDeleted, sessionsFailed };
  });
}

export function isValidSection(section: string): section is TaskSection {
  return Object.prototype.hasOwnProperty.call(SECTION_STATUS, section);
}

export async function migrateTaskApp(oldName: string, newName: string): Promise<number> {
  if (oldName === newName) return 0;
  let migrated = 0;
  for (const id of listMetaIds()) {
    const dir = join(SESSIONS_DIR, id);
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
