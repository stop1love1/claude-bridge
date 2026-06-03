/**
 * Pipeline engine — sequences a Workflow's ordered stages on a single
 * task / working tree.
 *
 * Flow:
 *   - `startWorkflowRun(id)` creates ONE task on the workflow's app and
 *     SNAPSHOTS the workflow's stages into `meta.pipeline` (so later edits /
 *     deletes of the workflow can't change an in-flight run). It moves
 *     TODO→DOING and dispatches stage 0 as an agent run via the agents path.
 *   - The engine subscribes to the meta-change bus. When the current stage's
 *     run reaches a settled terminal state, it advances:
 *       · done + verify passed (or stage.verify=false / no verify) → next stage
 *       · last stage done → finish (status `review`, write READY FOR REVIEW;
 *         NEVER auto-DONE — the user confirms)
 *       · done but verify failed (after the retry ladder exhausted) → BLOCKED
 *       · failed / stale → BLOCKED
 *   - Context carries forward via the shared working tree plus a handoff
 *     header in each stage's prompt. The repo is PINNED from the first stage
 *     so an auto-detect workflow keeps every stage on the same tree.
 *
 * Only the process-lock holder advances pipelines. Re-entrancy is guarded
 * per task, and `scheduleEval` is fired after recording the stage run so a
 * stage that finishes before its sessionId is recorded is never missed.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readMeta,
  subscribeMetaAll,
  withTaskLock,
  writeMeta,
  type MetaChangeEvent,
  type PipelineStageSnapshot,
} from "./meta";
import { createTask, updateTask } from "./tasksStore";
import { getWorkflow, recordWorkflowFire } from "./workflowStore";
import { SESSIONS_DIR, BRIDGE_URL } from "./paths";
import { INTERNAL_TOKEN_HEADER, loadAuthConfig } from "./auth";
import { isLockHolder } from "./processLock";
import { isValidTaskId } from "./tasks";
import { logError, logInfo, logWarn } from "./log";

/** Debounce so an exit→retry flip (crash-retry / verify-retry) settles
 *  before we evaluate the stage outcome. Verify/crash retries reuse the
 *  same sessionId (resume), so a brief flip back to `running` lands inside
 *  this window and the eval correctly skips. */
const EVAL_DEBOUNCE_MS = 2_500;

interface EngineState {
  installed: boolean;
  unsubscribe: (() => void) | null;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  advancing: Set<string>;
}

const G = globalThis as unknown as { __bridgePipelineEngine?: EngineState };
const state: EngineState =
  G.__bridgePipelineEngine ??
  (G.__bridgePipelineEngine = {
    installed: false,
    unsubscribe: null,
    timers: new Map(),
    advancing: new Set(),
  });

// ── Prompt composition ────────────────────────────────────────────────

export function composeStagePrompt(
  workflowName: string,
  stageCount: number,
  stage: PipelineStageSnapshot,
  stageIndex: number,
  completedStages: string[],
): string {
  const completed = completedStages.length ? completedStages.join(" → ") : "(none yet)";
  return [
    `## Pipeline: ${workflowName}`,
    "",
    `This task runs an ordered, multi-stage workflow. You are stage **${stageIndex + 1} of ${stageCount}**: **${stage.name}** (role: \`${stage.role}\`).`,
    `Completed stages so far: ${completed}. Their output is already in the working tree — build on it, do NOT redo earlier stages.`,
    "When you finish, the bridge automatically advances to the next stage (only if your work passes the verify gate, when this stage requires it).",
    "",
    "## Your stage instructions",
    "",
    stage.prompt,
  ].join("\n");
}

function snapshotStages(stages: PipelineStageSnapshot[]): string {
  return stages.map((s) => s.name).join(" → ");
}

// ── Pipeline state writes ─────────────────────────────────────────────

async function blockPipeline(taskId: string, reason: string): Promise<void> {
  const dir = join(SESSIONS_DIR, taskId);
  await withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta || !meta.pipeline) return;
    meta.pipeline.status = "blocked";
    meta.pipeline.stageRunSessionId = null;
    writeMeta(dir, meta);
  });
  await updateTask(taskId, { section: "BLOCKED" }).catch(() => {});
  logWarn("pipeline", `blocked: ${reason}`, { taskId });
}

async function finishPipeline(
  taskId: string,
  workflowName: string,
  stageCount: number,
  completedStages: string[],
): Promise<void> {
  const dir = join(SESSIONS_DIR, taskId);
  await withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta || !meta.pipeline) return;
    meta.pipeline.status = "review";
    meta.pipeline.stageRunSessionId = null;
    meta.pipeline.completedStages = completedStages;
    writeMeta(dir, meta);
  });
  // READY FOR REVIEW — leave the task in DOING for the user to confirm; the
  // pipeline NEVER auto-marks DONE.
  try {
    const summary = [
      "READY FOR REVIEW",
      "",
      `Workflow "${workflowName}" completed all ${stageCount} stage(s): ${completedStages.join(" → ")}.`,
      "Review the result and tick the task complete to archive it.",
      "",
    ].join("\n");
    writeFileSync(join(dir, "summary.md"), summary, "utf8");
  } catch (e) {
    logWarn("pipeline", "failed to write summary.md", { taskId, error: (e as Error).message });
  }
  logInfo("pipeline", `completed all stages → READY FOR REVIEW`, { taskId });
}

// ── Stage dispatch ────────────────────────────────────────────────────

/**
 * Dispatch the stage at `stageIndex` (read from the run's snapshot) as an
 * agent run via the agents route (loopback + internal token, so the run
 * gets the full prompt scaffolding + verify chain + retry ladder +
 * lifecycle). Records the run's sessionId + pins the resolved repo, then
 * fires an eval to cover the case where the stage finished before we
 * recorded its sessionId. Returns false on failure.
 */
async function dispatchStage(taskId: string, stageIndex: number): Promise<boolean> {
  const dir = join(SESSIONS_DIR, taskId);
  const meta = readMeta(dir);
  if (!meta?.pipeline) return false;
  const p = meta.pipeline;
  const stage = p.stages[stageIndex];
  if (!stage) return false;

  const prompt = composeStagePrompt(p.workflowName, p.stages.length, stage, stageIndex, p.completedStages);
  const cfg = loadAuthConfig();
  try {
    const res = await fetch(`${BRIDGE_URL}/api/tasks/${encodeURIComponent(taskId)}/agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg?.internalToken ? { [INTERNAL_TOKEN_HEADER]: cfg.internalToken } : {}),
      },
      body: JSON.stringify({
        role: stage.role,
        // Pin the repo from the first stage's resolved repo so every stage
        // runs on the SAME tree even when the workflow auto-detects.
        repo: p.repo ?? "",
        prompt,
        allowDuplicate: true, // stages may repeat a role; the engine sequences them
        requireUserApproval: false,
        noSpeculative: true, // one run per stage so the engine can track it
      }),
    });
    if (!res.ok) {
      logError("pipeline", `stage dispatch HTTP ${res.status}`, undefined, {
        taskId,
        stage: stage.name,
      });
      return false;
    }
    const data = (await res.json()) as { sessionId?: string; repo?: string };
    if (!data.sessionId) {
      logError("pipeline", "stage dispatch returned no sessionId", undefined, {
        taskId,
        stage: stage.name,
      });
      return false;
    }
    const sid = data.sessionId;
    const resolvedRepo = typeof data.repo === "string" && data.repo ? data.repo : null;
    await withTaskLock(dir, () => {
      const m = readMeta(dir);
      if (!m || !m.pipeline) return;
      m.pipeline.stageIndex = stageIndex;
      m.pipeline.stageRunSessionId = sid;
      m.pipeline.status = "running";
      // Pin the repo on the first stage that resolves one.
      if (m.pipeline.repo === null && resolvedRepo) m.pipeline.repo = resolvedRepo;
      writeMeta(dir, m);
    });
    logInfo("pipeline", `dispatched stage ${stageIndex + 1}/${p.stages.length} "${stage.name}"`, {
      taskId,
      sessionId: sid,
    });
    // Close the race where the stage's run reaches a terminal state BEFORE we
    // wrote stageRunSessionId (a fast stage). Now that the id is recorded,
    // re-evaluate; if the run already finished the eval advances, otherwise
    // it harmlessly no-ops and the run's own terminal transition re-triggers.
    scheduleEval(taskId);
    return true;
  } catch (e) {
    logError("pipeline", "stage dispatch threw", e, { taskId, stage: stage.name });
    return false;
  }
}

// ── Run lifecycle ─────────────────────────────────────────────────────

/**
 * Start a run of `workflowId`: snapshot its stages onto a new task and
 * dispatch the first stage. Returns the created task id, or null when the
 * workflow is missing / has no stages.
 */
export async function startWorkflowRun(workflowId: string): Promise<{ taskId: string } | null> {
  const wf = getWorkflow(workflowId);
  if (!wf || wf.stages.length === 0) return null;

  const snapshot: PipelineStageSnapshot[] = wf.stages.map((s) => ({
    name: s.name,
    role: s.role,
    prompt: s.prompt,
    verify: s.verify,
  }));

  const task = createTask({
    title: wf.name,
    body: `Pipeline run for workflow "${wf.name}". Stages: ${snapshotStages(snapshot)}.`,
    app: wf.app,
    origin: "pipeline",
    workflowId: wf.id,
  });
  const dir = join(SESSIONS_DIR, task.id);
  const now = new Date().toISOString();
  await withTaskLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return;
    meta.pipeline = {
      workflowId: wf.id,
      workflowName: wf.name,
      stages: snapshot,
      stageIndex: 0,
      stageCount: snapshot.length,
      repo: wf.app,
      stageRunSessionId: null,
      status: "running",
      startedAt: now,
      completedStages: [],
    };
    writeMeta(dir, meta);
  });
  await updateTask(task.id, { section: "DOING" }).catch(() => {});
  recordWorkflowFire(wf.id, task.id, Date.now());

  const ok = await dispatchStage(task.id, 0);
  if (!ok) {
    await blockPipeline(task.id, "failed to dispatch the first stage");
  }
  logInfo("pipeline", `started workflow "${wf.name}" → task ${task.id}`, { workflowId });
  return { taskId: task.id };
}

/**
 * Evaluate a pipeline task whose current stage run just settled. Advance,
 * finish, or block — using the SNAPSHOT in meta.pipeline (never the live
 * workflow), so mid-run edits/deletes can't corrupt sequencing. Guarded
 * against re-entrancy.
 */
async function advancePipeline(taskId: string): Promise<void> {
  if (state.advancing.has(taskId)) return;
  state.advancing.add(taskId);
  try {
    const dir = join(SESSIONS_DIR, taskId);
    const meta = readMeta(dir);
    if (!meta || !meta.pipeline || meta.pipeline.status !== "running") return;
    const p = meta.pipeline;
    if (!p.stageRunSessionId) return;
    const run = meta.runs.find((r) => r.sessionId === p.stageRunSessionId);
    if (!run) return;
    // Still in flight (a crash-/verify-retry flipped it back) → wait.
    if (run.status === "running" || run.status === "queued") return;

    const stage = p.stages[p.stageIndex];
    const stageName = stage?.name ?? `stage ${p.stageIndex + 1}`;

    if (run.status === "failed" || run.status === "stale") {
      await blockPipeline(taskId, `stage "${stageName}" failed (retries exhausted)`);
      return;
    }

    // run.status === "done". The lifecycle defers the done-flip until after
    // the verify chain, so run.verify is final here.
    if (stage?.verify && run.verify && run.verify.passed === false) {
      await blockPipeline(taskId, `stage "${stageName}" did not pass verify`);
      return;
    }

    const completed = [...p.completedStages, stageName];
    const nextIndex = p.stageIndex + 1;
    if (nextIndex >= p.stages.length) {
      await finishPipeline(taskId, p.workflowName, p.stages.length, completed);
      return;
    }
    // Persist the advanced index + completed list BEFORE dispatching the next
    // stage (dispatchStage reads completedStages from meta for the handoff).
    await withTaskLock(dir, () => {
      const m = readMeta(dir);
      if (!m || !m.pipeline) return;
      m.pipeline.stageIndex = nextIndex;
      m.pipeline.completedStages = completed;
      writeMeta(dir, m);
    });
    const ok = await dispatchStage(taskId, nextIndex);
    if (!ok) {
      await blockPipeline(taskId, `failed to dispatch stage ${nextIndex + 1}`);
    }
  } catch (e) {
    logError("pipeline", "advance failed", e, { taskId });
  } finally {
    state.advancing.delete(taskId);
  }
}

function scheduleEval(taskId: string): void {
  const existing = state.timers.get(taskId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    state.timers.delete(taskId);
    void advancePipeline(taskId);
  }, EVAL_DEBOUNCE_MS);
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
  state.timers.set(taskId, t);
}

function onMetaChange(ev: MetaChangeEvent): void {
  if (ev.kind !== "transition") return;
  const status = ev.run?.status;
  if (status !== "done" && status !== "failed" && status !== "stale") return;
  if (!isLockHolder()) return; // only the singleton advances pipelines
  scheduleEval(ev.taskId);
}

/** Idempotent, HMR-safe installer — call once from instrumentation. */
export function ensurePipelineEngine(): void {
  // Re-subscribe cleanly: drop any prior subscription so an HMR reload
  // doesn't leave a stale `onMetaChange` from the previous module instance.
  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch { /* ignore */ }
    state.unsubscribe = null;
  }
  state.installed = true;
  state.unsubscribe = subscribeMetaAll(onMetaChange);
  logInfo("pipeline", "engine installed");
}

// ── Introspection (for the scheduler cap + UI) ────────────────────────

function listTaskDirs(): string[] {
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

export interface ActivePipelineRun {
  taskId: string;
  workflowId: string;
  stageIndex: number;
  stageCount: number;
  status: "running" | "blocked" | "review";
}

/** All tasks that currently carry pipeline state (any status). */
export function listPipelineRuns(): ActivePipelineRun[] {
  const out: ActivePipelineRun[] = [];
  for (const id of listTaskDirs()) {
    const meta = readMeta(join(SESSIONS_DIR, id));
    if (!meta?.pipeline) continue;
    out.push({
      taskId: id,
      workflowId: meta.pipeline.workflowId,
      stageIndex: meta.pipeline.stageIndex,
      stageCount: meta.pipeline.stageCount,
      status: meta.pipeline.status,
    });
  }
  return out;
}

/** Number of pipeline runs still executing (status running) — the cap. */
export function countActivePipelines(): number {
  return listPipelineRuns().filter((r) => r.status === "running").length;
}
