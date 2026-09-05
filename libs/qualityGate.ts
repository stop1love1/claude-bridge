import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { appendRun, updateRun, type Run } from "./meta";
import { notifyGateInfraSkip } from "./gateEscalation";
import { getApp } from "./apps";
import { loadHouseRules } from "./houseRules";
import { topMemoryEntries } from "./memory";
import { loadPlaybook } from "./playbooks";
import { loadPinnedFiles } from "./pinnedFiles";
import { ensureFreshSymbolIndex } from "./symbolStore";
import { ensureFreshStyleFingerprint } from "./styleStore";
import { buildChildPrompt } from "./childPrompt";
import { denyTaskToolNames, spawnFreeSession } from "./spawn";
import {
  freeSessionSettingsPath,
  writeSessionSettings,
} from "./permissionSettings";
import { SESSIONS_DIR } from "./paths";
import { readMeta } from "./meta";
import { resolveModelForRun } from "./modelResolve";

export const GATE_TIMEOUT_MS = 10 * 60 * 1000;

const EXIT_TIMEOUT = -2;
const EXIT_SPAWN_ERR = -3;

export function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number = GATE_TIMEOUT_MS,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(code);
    };
    const onExit = (code: number | null) => settle(code ?? -1);
    const onError = () => settle(EXIT_SPAWN_ERR);
    child.once("exit", onExit);
    child.once("error", onError);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { }
      settle(EXIT_TIMEOUT);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

export function readVerdictFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface AgentGateOptions {
  appPath: string;
  taskId: string;
  finishedRun: Run;
  taskTitle: string;
  taskBody: string;
  role: string;
  runRole?: string;
  briefBody: string;
  verdictFileName: string;
  timeoutMs?: number;
}

export type AgentGateOutcome =
  | { kind: "spawned"; sessionId: string; verdict: unknown }
  | { kind: "skipped"; reason: string; sessionId?: string };

export async function runAgentGate(
  opts: AgentGateOptions,
): Promise<AgentGateOutcome> {
  const sessionsDir = join(SESSIONS_DIR, opts.taskId);

  if (opts.finishedRun.role === "coordinator") {
    return {
      kind: "skipped",
      reason: `role \`${opts.finishedRun.role}\` is exempt from agent quality gates`,
    };
  }

  const app = getApp(opts.finishedRun.repo);
  if (!app) {
    return { kind: "skipped", reason: "app not registered" };
  }

  const playbook = loadPlaybook(opts.role);
  if (!playbook) {
    return {
      kind: "skipped",
      reason: `playbook \`prompts/playbooks/${opts.role}.md\` is missing`,
    };
  }

  const houseRules = loadHouseRules(app.path);
  const memoryEntries = topMemoryEntries(app.path);
  const symbolIndex = ensureFreshSymbolIndex(
    app.name,
    app.path,
    app.symbolDirs,
  );
  const styleFingerprint = ensureFreshStyleFingerprint(app.name, app.path);
  const pinnedFiles = loadPinnedFiles(app.path, app.pinnedFiles);

  const sessionId = randomUUID();
  const model = resolveModelForRun({
    app,
    role: opts.role,
    taskModel: readMeta(sessionsDir)?.taskModel ?? null,
  });
  const prompt = buildChildPrompt({
    taskId: opts.taskId,
    taskTitle: opts.taskTitle,
    taskBody: opts.taskBody,
    parentSessionId: opts.finishedRun.parentSessionId ?? "(none)",
    childSessionId: sessionId,
    role: opts.role,
    repo: opts.finishedRun.repo,
    repoCwd: opts.appPath,
    contextBlock:
      "(quality gate — run `git diff HEAD` and `git status --porcelain` yourself to see what was just shipped)",
    coordinatorBody: opts.briefBody,
    houseRules,
    playbookBody: playbook,
    verifyHint: app.verify,
    symbolIndex,
    styleFingerprint,
    pinnedFiles,
    memoryEntries,
    verdictFileName: opts.verdictFileName,
  });

  await appendRun(sessionsDir, {
    sessionId,
    role: opts.runRole ?? opts.role,
    repo: opts.finishedRun.repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: opts.finishedRun.parentSessionId ?? null,
    model: model ?? null,
  });

  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
  let childHandle;
  try {
    childHandle = spawnFreeSession(
      opts.appPath,
      prompt,
      { mode: "bypassPermissions", disallowedTools: denyTaskToolNames(), model },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    await updateRun(sessionsDir, sessionId, {
      status: "failed",
      endedAt: new Date().toISOString(),
    });
    const reason = `${opts.role} spawn failed: ${(e as Error).message}`;
    await notifyGateInfraSkip({ taskId: opts.taskId, gate: opts.role, detail: reason });
    return { kind: "skipped", reason, sessionId };
  }

  const exitCode = await waitForChildExit(
    childHandle.child,
    opts.timeoutMs ?? GATE_TIMEOUT_MS,
  );
  const exitOk = exitCode === 0;
  await updateRun(sessionsDir, sessionId, {
    status: exitOk ? "done" : "failed",
    endedAt: new Date().toISOString(),
  });

  if (!exitOk) {
    const reason =
      exitCode === EXIT_TIMEOUT
        ? `${opts.role} timed out after ${opts.timeoutMs ?? GATE_TIMEOUT_MS}ms`
        : exitCode === EXIT_SPAWN_ERR
          ? `${opts.role} spawn errored before exit`
          : `${opts.role} exited with code ${exitCode}`;
    await notifyGateInfraSkip({ taskId: opts.taskId, gate: opts.role, detail: reason });
    return { kind: "skipped", reason, sessionId };
  }

  const verdictPath = join(sessionsDir, opts.verdictFileName);
  const verdict = readVerdictFile(verdictPath);
  if (verdict === null) {
    const reason = `${opts.role} did not write \`${opts.verdictFileName}\``;
    await notifyGateInfraSkip({ taskId: opts.taskId, gate: opts.role, detail: reason });
    return { kind: "skipped", reason, sessionId };
  }

  return { kind: "spawned", sessionId, verdict };
}
