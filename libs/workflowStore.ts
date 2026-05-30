/**
 * Persistent store for **workflows** (the "Quy trình" feature).
 *
 * A workflow is an operator-defined automation the bridge runs on its
 * own. Currently one kind: a CRON workflow that mints + auto-dispatches a
 * task on a schedule (interval or daily). The store also holds the global
 * SCHEDULER SETTINGS (auto-queue on/off + the concurrency cap) that the
 * auto-dispatch pump reads each tick.
 *
 * Backed by `.bridge-state/workflows.json`. The bridge is single-process
 * (enforced by `libs/processLock.ts`), so we keep an authoritative
 * in-memory copy on `globalThis` and write through on every mutation —
 * HMR-safe via the same globalThis stash the other stores use. All
 * mutations are synchronous (no `await` between read and write), so each
 * call is atomic with respect to the event loop.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";
import {
  computeNextRun,
  validateSchedule,
  type CronSchedule,
} from "./cronSchedule";

// Re-export so callers can treat CronSchedule as part of the workflow API
// surface (routes / client all import workflow types from here).
export type { CronSchedule } from "./cronSchedule";

const WORKFLOWS_FILE = join(BRIDGE_STATE_DIR, "workflows.json");

/** How many minted task ids to keep per workflow for the UI history. */
const HISTORY_CAP = 20;

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  /** Target app name; null = "auto" (coordinator decides). */
  app: string | null;
  /** Title for tasks this workflow mints. */
  title: string;
  /** Body for tasks this workflow mints. */
  body: string;
  createdAt: string;
  /** ISO of the last time this workflow minted a task; null = never. */
  lastRunAt: string | null;
  /** Epoch ms of the next scheduled fire; null when disabled. */
  nextRunAt: number | null;
  /** Most-recent-first task ids this workflow minted (capped). */
  history: string[];
}

export interface SchedulerSettings {
  /** Master switch for the auto-queue pump (auto-flagged TODO tasks). */
  autoDispatchEnabled: boolean;
  /** Max tasks worked concurrently (live coordinators) the pump allows. */
  maxConcurrentCoordinators: number;
}

interface StoreShape {
  workflows: Workflow[];
  settings: SchedulerSettings;
}

interface StoreState {
  data: StoreShape;
  loaded: boolean;
}

export const DEFAULT_SETTINGS: SchedulerSettings = {
  autoDispatchEnabled: true,
  maxConcurrentCoordinators: 2,
};

const MAX_CAP = 10;

function clampCap(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SETTINGS.maxConcurrentCoordinators;
  return Math.min(MAX_CAP, Math.max(1, Math.floor(n)));
}

const G = globalThis as unknown as { __bridgeWorkflowStore?: StoreState };
const state: StoreState =
  G.__bridgeWorkflowStore ??
  (G.__bridgeWorkflowStore = {
    data: { workflows: [], settings: { ...DEFAULT_SETTINGS } },
    loaded: false,
  });

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(WORKFLOWS_FILE)) {
      const raw = readFileSync(WORKFLOWS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      state.data = {
        workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
        settings: {
          autoDispatchEnabled:
            parsed.settings?.autoDispatchEnabled ?? DEFAULT_SETTINGS.autoDispatchEnabled,
          maxConcurrentCoordinators: clampCap(parsed.settings?.maxConcurrentCoordinators),
        },
      };
    }
  } catch (err) {
    // Corrupt file → start clean rather than crash, but DON'T do it
    // silently: log loudly and preserve the bad file as `.corrupt` so the
    // operator can recover, instead of having the next write overwrite it
    // with empty state and lose every workflow definition.
    console.error(
      `[workflowStore] ${WORKFLOWS_FILE} is unreadable — starting empty and preserving the bad copy as .corrupt:`,
      (err as Error).message,
    );
    try {
      renameSync(WORKFLOWS_FILE, `${WORKFLOWS_FILE}.corrupt`);
    } catch {
      /* best-effort backup */
    }
    state.data = { workflows: [], settings: { ...DEFAULT_SETTINGS } };
  }
  state.loaded = true;
}

function persist(): void {
  writeJsonAtomic(WORKFLOWS_FILE, state.data);
}

function genId(): string {
  return `wf_${randomBytes(8).toString("hex")}`;
}

// ── Settings ──────────────────────────────────────────────────────────

export function getSchedulerSettings(): SchedulerSettings {
  load();
  return { ...state.data.settings };
}

export function setSchedulerSettings(patch: Partial<SchedulerSettings>): SchedulerSettings {
  load();
  if (patch.autoDispatchEnabled !== undefined) {
    state.data.settings.autoDispatchEnabled = !!patch.autoDispatchEnabled;
  }
  if (patch.maxConcurrentCoordinators !== undefined) {
    state.data.settings.maxConcurrentCoordinators = clampCap(patch.maxConcurrentCoordinators);
  }
  persist();
  return { ...state.data.settings };
}

// ── Workflow CRUD ─────────────────────────────────────────────────────

export function listWorkflows(): Workflow[] {
  load();
  return state.data.workflows.map((w) => ({ ...w, history: [...w.history] }));
}

export function getWorkflow(id: string): Workflow | null {
  load();
  const w = state.data.workflows.find((x) => x.id === id);
  return w ? { ...w, history: [...w.history] } : null;
}

export interface CreateWorkflowInput {
  name: string;
  schedule: CronSchedule;
  app?: string | null;
  title: string;
  body?: string;
  enabled?: boolean;
}

/**
 * Create a workflow. Throws on an invalid schedule (caller should
 * surface a 400). `nextRunAt` is computed from now when enabled.
 */
export function createWorkflow(input: CreateWorkflowInput): Workflow {
  load();
  const scheduleErr = validateSchedule(input.schedule);
  if (scheduleErr) throw new Error(scheduleErr);
  const name = input.name.trim().slice(0, 120) || "(unnamed)";
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new Error("title required");
  const enabled = input.enabled ?? true;
  const now = Date.now();
  const wf: Workflow = {
    id: genId(),
    name,
    enabled,
    schedule: input.schedule,
    app: input.app && input.app.trim() ? input.app.trim() : null,
    title,
    body: (input.body ?? "").slice(0, 8000),
    createdAt: new Date(now).toISOString(),
    lastRunAt: null,
    nextRunAt: enabled ? computeNextRun(input.schedule, now) : null,
    history: [],
  };
  state.data.workflows.push(wf);
  persist();
  return { ...wf, history: [] };
}

export interface UpdateWorkflowPatch {
  name?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  app?: string | null;
  title?: string;
  body?: string;
}

/**
 * Patch a workflow. Recomputes `nextRunAt` when the schedule changes or
 * the workflow flips enabled→on. Returns null if not found, throws on an
 * invalid schedule.
 */
export function updateWorkflow(id: string, patch: UpdateWorkflowPatch): Workflow | null {
  load();
  const wf = state.data.workflows.find((x) => x.id === id);
  if (!wf) return null;

  if (patch.schedule !== undefined) {
    const err = validateSchedule(patch.schedule);
    if (err) throw new Error(err);
    wf.schedule = patch.schedule;
  }
  if (patch.name !== undefined) wf.name = patch.name.trim().slice(0, 120) || "(unnamed)";
  if (patch.app !== undefined) wf.app = patch.app && patch.app.trim() ? patch.app.trim() : null;
  if (patch.title !== undefined) {
    const t = patch.title.trim().slice(0, 200);
    if (!t) throw new Error("title required");
    wf.title = t;
  }
  if (patch.body !== undefined) wf.body = patch.body.slice(0, 8000);

  const wasEnabled = wf.enabled;
  if (patch.enabled !== undefined) wf.enabled = !!patch.enabled;

  // Recompute the next fire time when the schedule changed or we just
  // turned the workflow on. Turning it off clears nextRunAt.
  const scheduleChanged = patch.schedule !== undefined;
  const justEnabled = !wasEnabled && wf.enabled;
  if (!wf.enabled) {
    wf.nextRunAt = null;
  } else if (scheduleChanged || justEnabled || wf.nextRunAt === null) {
    wf.nextRunAt = computeNextRun(wf.schedule, Date.now());
  }

  persist();
  return { ...wf, history: [...wf.history] };
}

export function deleteWorkflow(id: string): boolean {
  load();
  const before = state.data.workflows.length;
  state.data.workflows = state.data.workflows.filter((x) => x.id !== id);
  const removed = state.data.workflows.length < before;
  if (removed) persist();
  return removed;
}

/**
 * Record that a workflow fired: stamp lastRunAt, prepend the minted task
 * id to history (capped), and recompute nextRunAt from `firedAtMs`.
 * No-op when the workflow no longer exists.
 */
export function recordWorkflowFire(id: string, taskId: string, firedAtMs: number): void {
  load();
  const wf = state.data.workflows.find((x) => x.id === id);
  if (!wf) return;
  wf.lastRunAt = new Date(firedAtMs).toISOString();
  wf.history = [taskId, ...wf.history].slice(0, HISTORY_CAP);
  wf.nextRunAt = wf.enabled ? computeNextRun(wf.schedule, firedAtMs) : null;
  persist();
}

/** Test isolation — drop in-memory + on-disk state. */
export function _resetForTests(): void {
  state.data = { workflows: [], settings: { ...DEFAULT_SETTINGS } };
  state.loaded = false;
}

export const _internal = { WORKFLOWS_FILE };
