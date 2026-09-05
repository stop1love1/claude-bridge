import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";
import { writeJsonAtomic } from "./atomicWrite";
import { SECTION_STATUS, type TaskDispatch, type TaskStatus, type TaskSection } from "./tasks";
import type { DetectedScopeCacheEntry } from "./detect/types";
import { SESSIONS_DIR } from "./paths";
import type { RunStatus } from "./runStatus";
import type { IntakeRecord } from "./planGate";
import { defaultIntake } from "./planGate";
import { logWarn } from "./log";

export type { RunStatus };
export type { IntakeRecord } from "./planGate";

function atomicWriteJson(filePath: string, value: unknown): void {
  writeJsonAtomic(filePath, value);
}

export interface Run {
  sessionId: string;
  role: string;
  repo: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  parentSessionId?: string | null;
  retryOf?: string | null;
  retryAttempt?: number | null;
  verify?: RunVerify | null;
  verifier?: RunVerifier | null;
  styleCritic?: RunStyleCritic | null;
  semanticVerifier?: RunSemanticVerifier | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  worktreeBaseBranch?: string | null;
  speculativeGroup?: string | null;
  speculativeOutcome?: "won" | "lost" | null;
  mergeNotPushed?: {
    message: string;
    error: string | null;
    at: string;
  } | null;
  confidence?: {
    score: number;
    band: "high" | "medium" | "low";
    heldAt?: string | null;
    reviewedBy?: { label: string; at: string } | null;
  } | null;
}

export interface RunVerify {
  steps: RunVerifyStep[];
  passed: boolean;
  startedAt: string;
  endedAt: string;
  retryScheduled?: boolean;
}

export interface RunVerifyStep {
  name: "format" | "lint" | "typecheck" | "test" | "build";
  cmd: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface RunVerifier {
  verdict: "pass" | "drift" | "broken" | "skipped" | "crashed";
  reason: string;
  claimedFiles: string[];
  actualFiles: string[];
  unmatchedClaims: string[];
  unclaimedActual: string[];
  durationMs: number;
  retryScheduled?: boolean;
}

export interface RunStyleCritic {
  verdict: "match" | "drift" | "alien" | "skipped" | "crashed";
  reason: string;
  issues: string[];
  criticSessionId?: string | null;
  durationMs: number;
  retryScheduled?: boolean;
  panelSize?: number;
  votes?: Array<{
    lens: string;
    verdict: "match" | "drift" | "alien";
    reason: string;
  }>;
}

export interface RunSemanticVerifier {
  verdict: "pass" | "drift" | "broken" | "skipped" | "crashed";
  reason: string;
  concerns: string[];
  verifierSessionId?: string | null;
  durationMs: number;
  retryScheduled?: boolean;
  panelSize?: number;
  votes?: Array<{
    lens: string;
    verdict: "pass" | "drift" | "broken";
    reason: string;
  }>;
}

export interface Meta {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: TaskStatus;
  taskSection: TaskSection;
  taskChecked: boolean;
  taskApp?: string | null;
  taskEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" | null;
  createdAt: string;
  origin?: "manual" | "cron" | "pipeline";
  workflowId?: string | null;
  dispatch?: TaskDispatch;
  scheduledAt?: string | null;
  pipeline?: PipelineRunState | null;
  runs: Run[];
  detectedScope?: DetectedScopeCacheEntry | null;
  intake?: IntakeRecord | null;
}

export interface PipelineStageSnapshot {
  name: string;
  role: string;
  prompt: string;
  verify: boolean;
}

export interface PipelineRunState {
  workflowId: string;
  workflowName: string;
  stages: PipelineStageSnapshot[];
  stageIndex: number;
  stageCount: number;
  repo: string | null;
  stageRunSessionId: string | null;
  status: "running" | "blocked" | "review";
  startedAt: string;
  completedStages: string[];
}

const FILE = "meta.json";

export interface MetaChangeEvent {
  taskId: string;
  kind:
    | "spawned"
    | "transition"
    | "updated"
    | "writeMeta"
    | "retried"
    | "task-section"
    | "coordinator-nudge"
    | "intake-awaiting-approval";
  sessionId?: string;
  run?: Run;
  prevStatus?: RunStatus;
  retryOf?: string;
  prevSection?: TaskSection;
  nextSection?: TaskSection;
  taskTitle?: string;
  taskChecked?: boolean;
  reason?: string;
}

interface MetaEvents {
  emitter: EventEmitter;
}

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

export function subscribeMetaAll(
  cb: (ev: MetaChangeEvent) => void,
): () => void {
  const handler = (ev: MetaChangeEvent) => {
    try { cb(ev); } catch { }
  };
  events.emitter.on("meta:changed", handler);
  return () => events.emitter.off("meta:changed", handler);
}

function taskIdFromDir(dir: string): string {
  return basename(dir);
}

function emit(dir: string, ev: MetaChangeEvent): void {
  if (dir) metaCache.delete(dir);
  events.emitter.emit("meta:changed", ev);
}

const META_CACHE_TTL_MS = 500;
// Caches the raw file text, not the parsed object: the cache exists to skip
// the disk read, and re-parsing per call is what hands every caller its own
// object (cheaper than structuredClone on a meta this size).
const metaCache = new Map<string, { json: string | null; expires: number }>();

const GW = globalThis as unknown as {
  __bridgeMetaWriteQueues?: Map<string, Promise<unknown>>;
};
const writeQueues: Map<string, Promise<unknown>> =
  GW.__bridgeMetaWriteQueues ?? new Map<string, Promise<unknown>>();
GW.__bridgeMetaWriteQueues = writeQueues;
export async function withTaskLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = writeQueues.get(dir) ?? Promise.resolve();
  const next: Promise<T> = prev.then(
    () => fn(),
    () => fn(),
  );
  const tail = next.catch(() => {});
  writeQueues.set(dir, tail);
  try {
    return await next;
  } finally {
    if (writeQueues.get(dir) === tail) writeQueues.delete(dir);
  }
}

export function emitRetried(taskId: string, retryRun: Run, retryOf: string): void {
  const dir = join(SESSIONS_DIR, taskId);
  emit(dir, {
    taskId,
    kind: "retried",
    sessionId: retryRun.sessionId,
    run: retryRun,
    retryOf,
  });
}

export function emitCoordinatorNudge(args: {
  taskId: string;
  parentSessionId: string;
  coordinatorRun: Run;
  reason: string;
}): void {
  const dir = join(SESSIONS_DIR, args.taskId);
  emit(dir, {
    taskId: args.taskId,
    kind: "coordinator-nudge",
    sessionId: args.parentSessionId,
    run: args.coordinatorRun,
    reason: args.reason,
  });
}

export function emitTaskSection(args: {
  taskId: string;
  prevSection: TaskSection;
  nextSection: TaskSection;
  taskTitle: string;
  taskChecked: boolean;
}): void {
  if (args.prevSection === args.nextSection) return;
  const dir = join(SESSIONS_DIR, args.taskId);
  emit(dir, {
    taskId: args.taskId,
    kind: "task-section",
    prevSection: args.prevSection,
    nextSection: args.nextSection,
    taskTitle: args.taskTitle,
    taskChecked: args.taskChecked,
  });
}

export function emitIntakeAwaitingApproval(args: {
  taskId: string;
  taskTitle: string;
}): void {
  const dir = join(SESSIONS_DIR, args.taskId);
  emit(dir, {
    taskId: args.taskId,
    kind: "intake-awaiting-approval",
    taskTitle: args.taskTitle,
  });
}

export function createMeta(dir: string, header: Omit<Meta, "runs">): void {
  mkdirSync(dir, { recursive: true });
  const meta: Meta = { ...header, runs: [] };
  atomicWriteJson(join(dir, FILE), meta);
  emit(dir, { taskId: taskIdFromDir(dir), kind: "writeMeta" });
}

const META_CACHE_MAX_ENTRIES = 1024;

function isValidMetaShape(value: unknown): value is Meta {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.runs)) return false;
  if (typeof v.createdAt !== "string") return false;
  if (
    typeof v.taskSection !== "string" ||
    !Object.prototype.hasOwnProperty.call(SECTION_STATUS, v.taskSection)
  ) {
    return false;
  }
  return true;
}

// Writers mutate the object they read (`Object.assign(run, patch)`), and a
// route can hold a snapshot across several awaits — so no two callers may
// share one object, or a concurrent write rewrites a reader's view mid-flight.
export function readMeta(dir: string): Meta | null {
  const now = Date.now();
  const cached = metaCache.get(dir);
  if (cached && cached.expires > now) {
    metaCache.delete(dir);
    metaCache.set(dir, cached);
    return cached.json === null ? null : (JSON.parse(cached.json) as Meta);
  }

  const p = join(dir, FILE);
  if (!existsSync(p)) {
    metaCache.set(dir, { json: null, expires: now + META_CACHE_TTL_MS });
    return null;
  }
  let value: Meta | null;
  let json: string | null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidMetaShape(parsed)) {
      logWarn("meta", `invalid meta.json shape at ${p}`, { path: p });
      value = null;
      json = null;
    } else {
      value = parsed;
      json = raw;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") {
      logWarn("meta", `corrupt meta.json at ${p}`, { path: p, error: (err as Error).message });
    }
    value = null;
    json = null;
  }
  metaCache.delete(dir);
  metaCache.set(dir, { json, expires: now + META_CACHE_TTL_MS });
  if (metaCache.size > META_CACHE_MAX_ENTRIES) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  return value;
}

export function writeMeta(dir: string, meta: Meta): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(join(dir, FILE), meta);
  emit(dir, { taskId: taskIdFromDir(dir), kind: "writeMeta" });
}

export function emitRunUpdated(
  dir: string,
  run: Run,
  prevStatus: RunStatus,
): void {
  const statusChanged = run.status !== prevStatus;
  emit(dir, {
    taskId: taskIdFromDir(dir),
    kind: statusChanged ? "transition" : "updated",
    sessionId: run.sessionId,
    run: { ...run },
    prevStatus,
  });
}

export async function appendRun(dir: string, run: Run): Promise<void> {
  await withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) throw new Error(`meta.json missing at ${dir}`);
    meta.runs.push(run);
    atomicWriteJson(join(dir, FILE), meta);
    emit(dir, {
      taskId: taskIdFromDir(dir),
      kind: "spawned",
      sessionId: run.sessionId,
      run,
    });
  });
}

export async function appendRunIfNotDuplicate(
  dir: string,
  run: Run,
  isDuplicate: (existing: Run) => boolean,
): Promise<{ inserted: true; run: Run } | { inserted: false; existing: Run }> {
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) throw new Error(`meta.json missing at ${dir}`);
    const existing = meta.runs.find((r) => isDuplicate(r));
    if (existing) {
      return { inserted: false as const, existing };
    }
    meta.runs.push(run);
    atomicWriteJson(join(dir, FILE), meta);
    emit(dir, {
      taskId: taskIdFromDir(dir),
      kind: "spawned",
      sessionId: run.sessionId,
      run,
    });
    return { inserted: true as const, run };
  });
}

export async function updateRun(
  dir: string,
  sessionId: string,
  patch: Partial<Run>,
  precondition?: (run: Run, meta: Meta) => boolean,
): Promise<{ applied: boolean; run: Run | null }> {
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) throw new Error(`meta.json missing at ${dir}`);
    const run = meta.runs.find((r) => r.sessionId === sessionId);
    if (!run) throw new Error(`run ${sessionId} not found`);
    if (precondition && !precondition(run, meta)) {
      return { applied: false as const, run: { ...run } };
    }
    const prevStatus = run.status;
    Object.assign(run, patch);
    atomicWriteJson(join(dir, FILE), meta);
    const statusChanged = patch.status !== undefined && patch.status !== prevStatus;
    emit(dir, {
      taskId: taskIdFromDir(dir),
      kind: statusChanged ? "transition" : "updated",
      sessionId,
      run: { ...run },
      prevStatus,
    });
    return { applied: true as const, run: { ...run } };
  });
}

export function readIntake(dir: string): IntakeRecord | null {
  const meta = readMeta(dir);
  return meta?.intake ?? null;
}

export function setIntake(
  dir: string,
  patch: Partial<IntakeRecord>,
): Promise<IntakeRecord | null> {
  return withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return null;
    const base = meta.intake ?? defaultIntake();
    const next: IntakeRecord = { ...base, ...patch, updatedAt: new Date().toISOString() };
    meta.intake = next;
    atomicWriteJson(join(dir, FILE), meta);
    emit(dir, { taskId: taskIdFromDir(dir), kind: "writeMeta" });
    return next;
  });
}

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
    const pending: MetaChangeEvent[] = [];
    let mutated = false;
    for (const { sessionId, patch } of patches) {
      const run = meta.runs.find((r) => r.sessionId === sessionId);
      if (!run) continue;
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
      for (const ev of pending) emit(dir, ev);
    }
    return meta;
  });
}

export function findSessionTaskDirs(sessionId: string): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const hits: string[] = [];
  for (const taskId of readdirSync(SESSIONS_DIR)) {
    const dir = join(SESSIONS_DIR, taskId);
    const meta = readMeta(dir);
    if (!meta) continue;
    if (meta.runs.some((r) => r.sessionId === sessionId)) hits.push(dir);
  }
  return hits;
}

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
    emit(dir, { taskId: taskIdFromDir(dir), kind: "writeMeta" });
    return true;
  });
}
