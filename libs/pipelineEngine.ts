
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
        repo: p.repo ?? "",
        prompt,
        allowDuplicate: true,
        requireUserApproval: false,
        noSpeculative: true,
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
      if (m.pipeline.repo === null && resolvedRepo) m.pipeline.repo = resolvedRepo;
      writeMeta(dir, m);
    });
    logInfo("pipeline", `dispatched stage ${stageIndex + 1}/${p.stages.length} "${stage.name}"`, {
      taskId,
      sessionId: sid,
    });
    scheduleEval(taskId);
    return true;
  } catch (e) {
    logError("pipeline", "stage dispatch threw", e, { taskId, stage: stage.name });
    return false;
  }
}


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
    if (run.status === "running" || run.status === "queued") return;

    const stage = p.stages[p.stageIndex];
    const stageName = stage?.name ?? `stage ${p.stageIndex + 1}`;

    if (run.status === "cancelled") {
      await blockPipeline(taskId, `stage "${stageName}" was cancelled by the operator`);
      return;
    }

    if (run.status === "failed" || run.status === "stale") {
      await blockPipeline(taskId, `stage "${stageName}" failed (retries exhausted)`);
      return;
    }

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
  if (status !== "done" && status !== "failed" && status !== "cancelled" && status !== "stale") return;
  if (!isLockHolder()) return;
  scheduleEval(ev.taskId);
}

export function ensurePipelineEngine(): void {
  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch { }
    state.unsubscribe = null;
  }
  state.installed = true;
  state.unsubscribe = subscribeMetaAll(onMetaChange);
  logInfo("pipeline", "engine installed");
}


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

export function countActivePipelines(): number {
  return listPipelineRuns().filter((r) => r.status === "running").length;
}
