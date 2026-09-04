
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
import { logError } from "./log";

export type { CronSchedule } from "./cronSchedule";

const WORKFLOWS_FILE = join(BRIDGE_STATE_DIR, "workflows.json");

const HISTORY_CAP = 20;

export interface WorkflowStage {
  id: string;
  name: string;
  role: string;
  prompt: string;
  verify: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  app: string | null;
  stages: WorkflowStage[];
  enabled: boolean;
  schedule: CronSchedule | null;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: number | null;
  history: string[];
}

export interface SchedulerSettings {
  cronEnabled: boolean;
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
    logError(
      "workflow-store",
      `${WORKFLOWS_FILE} is unreadable — starting empty and preserving the bad copy as .corrupt`,
      err,
    );
    try {
      renameSync(WORKFLOWS_FILE, `${WORKFLOWS_FILE}.corrupt`);
    } catch {
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


export interface StageInput {
  name: string;
  role: string;
  prompt: string;
  verify?: boolean;
}

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

export function recordWorkflowFire(id: string, taskId: string, firedAtMs: number): void {
  load();
  const wf = state.data.workflows.find((x) => x.id === id);
  if (!wf) return;
  wf.lastRunAt = new Date(firedAtMs).toISOString();
  wf.history = [taskId, ...wf.history].slice(0, HISTORY_CAP);
  wf.nextRunAt = wf.enabled && wf.schedule ? computeNextRun(wf.schedule, firedAtMs) : null;
  persist();
}

export function _resetForTests(): void {
  state.data = { workflows: [], settings: { ...DEFAULT_SETTINGS } };
  state.loaded = false;
}

export const _internal = { WORKFLOWS_FILE };
