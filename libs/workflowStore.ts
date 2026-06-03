/**
 * Persistent store for **workflows** (the "Workflows" feature).
 *
 * A workflow is an operator-defined, ordered PIPELINE of stages. Each
 * stage runs an agent (role + prompt) on the SAME task/working tree, and
 * the pipeline engine (`libs/pipelineEngine.ts`) advances to the next
 * stage only when the current one finishes (and passes verify, when the
 * stage requires it). Stages are fully user-defined — nothing is
 * hardcoded; "Code → Test → Review" is just one example a user might
 * build.
 *
 * The store also holds global SCHEDULER SETTINGS (cron on/off + the
 * max-concurrent-runs cap).
 *
 * Backed by `.bridge-state/workflows.json`. Single-process (enforced by
 * `libs/processLock.ts`), so we keep an authoritative in-memory copy on
 * `globalThis` and write through on every mutation — HMR-safe. All
 * mutations are synchronous, so each call is atomic w.r.t. the event loop.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";
import { isValidAgentRole } from "./validate";
import {
  computeNextRun,
  validateSchedule,
  type CronSchedule,
} from "./cronSchedule";

// Re-export so callers can treat CronSchedule as part of the workflow API.
export type { CronSchedule } from "./cronSchedule";

const WORKFLOWS_FILE = join(BRIDGE_STATE_DIR, "workflows.json");

/** Keep this many past run task-ids per workflow for the UI history. */
const HISTORY_CAP = 20;

/** One ordered step of a workflow pipeline. Fully user-defined. */
export interface WorkflowStage {
  /** Stable id within the workflow. */
  id: string;
  /** Display label, e.g. "Code", "Test", "Review" (arbitrary). */
  name: string;
  /** Agent role for this stage (validated charset). */
  role: string;
  /** Instructions handed to the stage's agent. */
  prompt: string;
  /** Require the verify gate (if the app configures one) to pass before
   *  advancing to the next stage. */
  verify: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  /** Target app/repo all stages run on; null = auto-detect. */
  app: string | null;
  /** Ordered pipeline stages. */
  stages: WorkflowStage[];
  enabled: boolean;
  /** Optional cron trigger to auto-run the pipeline; null = manual only. */
  schedule: CronSchedule | null;
  createdAt: string;
  /** ISO of the last time a run was started; null = never. */
  lastRunAt: string | null;
  /** Epoch ms of the next scheduled auto-run; null when no schedule/disabled. */
  nextRunAt: number | null;
  /** Most-recent-first task ids of runs this workflow started (capped). */
  history: string[];
}

export interface SchedulerSettings {
  /** Master switch for cron-triggered auto-runs. */
  cronEnabled: boolean;
  /** Max workflow runs in flight at once (cron defers new runs past this). */
  maxConcurrentRuns: number;
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
  cronEnabled: true,
  maxConcurrentRuns: 2,
};

const MAX_CAP = 10;

function clampCap(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SETTINGS.maxConcurrentRuns;
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
          cronEnabled: parsed.settings?.cronEnabled ?? DEFAULT_SETTINGS.cronEnabled,
          maxConcurrentRuns: clampCap(parsed.settings?.maxConcurrentRuns),
        },
      };
    }
  } catch (err) {
    // Corrupt file → start clean rather than crash, but DON'T do it
    // silently: log and preserve the bad file as `.corrupt` so the
    // operator can recover instead of having the next write overwrite it.
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

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// ── Settings ──────────────────────────────────────────────────────────

export function getSchedulerSettings(): SchedulerSettings {
  load();
  return { ...state.data.settings };
}

export function setSchedulerSettings(patch: Partial<SchedulerSettings>): SchedulerSettings {
  load();
  if (patch.cronEnabled !== undefined) {
    state.data.settings.cronEnabled = !!patch.cronEnabled;
  }
  if (patch.maxConcurrentRuns !== undefined) {
    state.data.settings.maxConcurrentRuns = clampCap(patch.maxConcurrentRuns);
  }
  persist();
  return { ...state.data.settings };
}

// ── Stage validation ──────────────────────────────────────────────────

export interface StageInput {
  name: string;
  role: string;
  prompt: string;
  verify?: boolean;
}

/** Validate + normalize a stage list. Throws on the first invalid stage. */
function normalizeStages(stages: StageInput[] | undefined): WorkflowStage[] {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("at least one stage is required");
  }
  if (stages.length > 20) {
    throw new Error("too many stages (max 20)");
  }
  return stages.map((s, i) => {
    const name = (s.name ?? "").trim().slice(0, 80);
    const role = (s.role ?? "").trim();
    const prompt = (s.prompt ?? "").trim();
    if (!name) throw new Error(`stage ${i + 1}: name required`);
    if (!isValidAgentRole(role)) throw new Error(`stage ${i + 1}: invalid role "${role}"`);
    if (!prompt) throw new Error(`stage ${i + 1}: prompt required`);
    return {
      id: genId("st"),
      name,
      role,
      prompt: prompt.slice(0, 8000),
      verify: s.verify ?? true,
    };
  });
}

function clone(wf: Workflow): Workflow {
  return { ...wf, stages: wf.stages.map((s) => ({ ...s })), history: [...wf.history] };
}

// ── Workflow CRUD ─────────────────────────────────────────────────────

export function listWorkflows(): Workflow[] {
  load();
  return state.data.workflows.map(clone);
}

export function getWorkflow(id: string): Workflow | null {
  load();
  const w = state.data.workflows.find((x) => x.id === id);
  return w ? clone(w) : null;
}

export interface CreateWorkflowInput {
  name: string;
  app?: string | null;
  stages: StageInput[];
  enabled?: boolean;
  schedule?: CronSchedule | null;
}

/**
 * Create a workflow. Throws on invalid stages / schedule (caller surfaces
 * a 400). `nextRunAt` is computed from now when enabled AND scheduled.
 */
export function createWorkflow(input: CreateWorkflowInput): Workflow {
  load();
  const name = (input.name ?? "").trim().slice(0, 120) || "(unnamed)";
  const stages = normalizeStages(input.stages);
  const schedule = input.schedule ?? null;
  if (schedule) {
    const err = validateSchedule(schedule);
    if (err) throw new Error(err);
  }
  const enabled = input.enabled ?? true;
  const now = Date.now();
  const wf: Workflow = {
    id: genId("wf"),
    name,
    app: input.app && input.app.trim() ? input.app.trim() : null,
    stages,
    enabled,
    schedule,
    createdAt: new Date(now).toISOString(),
    lastRunAt: null,
    nextRunAt: enabled && schedule ? computeNextRun(schedule, now) : null,
    history: [],
  };
  state.data.workflows.push(wf);
  persist();
  return clone(wf);
}

export interface UpdateWorkflowPatch {
  name?: string;
  enabled?: boolean;
  schedule?: CronSchedule | null;
  app?: string | null;
  stages?: StageInput[];
}

/**
 * Patch a workflow. Recomputes `nextRunAt` when the schedule changes or
 * the workflow flips enabled→on. Returns null if not found, throws on
 * invalid stages/schedule.
 */
export function updateWorkflow(id: string, patch: UpdateWorkflowPatch): Workflow | null {
  load();
  const wf = state.data.workflows.find((x) => x.id === id);
  if (!wf) return null;

  if (patch.stages !== undefined) wf.stages = normalizeStages(patch.stages);
  if (patch.name !== undefined) wf.name = patch.name.trim().slice(0, 120) || "(unnamed)";
  if (patch.app !== undefined) wf.app = patch.app && patch.app.trim() ? patch.app.trim() : null;

  let scheduleChanged = false;
  if (patch.schedule !== undefined) {
    if (patch.schedule === null) {
      wf.schedule = null;
    } else {
      const err = validateSchedule(patch.schedule);
      if (err) throw new Error(err);
      wf.schedule = patch.schedule;
    }
    scheduleChanged = true;
  }

  const wasEnabled = wf.enabled;
  if (patch.enabled !== undefined) wf.enabled = !!patch.enabled;
  const justEnabled = !wasEnabled && wf.enabled;

  // Recompute the next auto-run time. No schedule (or disabled) → null.
  if (!wf.enabled || !wf.schedule) {
    wf.nextRunAt = null;
  } else if (scheduleChanged || justEnabled || wf.nextRunAt === null) {
    wf.nextRunAt = computeNextRun(wf.schedule, Date.now());
  }

  persist();
  return clone(wf);
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
 * Record that a workflow started a run: stamp lastRunAt, prepend the task
 * id to history (capped), and recompute nextRunAt from `firedAtMs` (only
 * when enabled + scheduled). No-op when the workflow no longer exists.
 */
export function recordWorkflowFire(id: string, taskId: string, firedAtMs: number): void {
  load();
  const wf = state.data.workflows.find((x) => x.id === id);
  if (!wf) return;
  wf.lastRunAt = new Date(firedAtMs).toISOString();
  wf.history = [taskId, ...wf.history].slice(0, HISTORY_CAP);
  wf.nextRunAt = wf.enabled && wf.schedule ? computeNextRun(wf.schedule, firedAtMs) : null;
  persist();
}

/** Test isolation — drop in-memory + on-disk state. */
export function _resetForTests(): void {
  state.data = { workflows: [], settings: { ...DEFAULT_SETTINGS } };
  state.loaded = false;
}

export const _internal = { WORKFLOWS_FILE };
