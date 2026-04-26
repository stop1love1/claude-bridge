/**
 * P2b-2 — shared runner for agent-driven quality gates.
 *
 * Both the style critic (`lib/styleCritic.ts`) and the semantic verifier
 * (`lib/semanticVerifier.ts`) follow the same shape:
 *
 *   1. Skip if preconditions aren't met (role is a retry, app missing,
 *      playbook missing, etc.) — return a `skipped` verdict.
 *   2. Build the gate's child prompt via `buildChildPrompt` with all the
 *      standard sections (House style, Available helpers, Pinned context,
 *      …) so the agent has the same ground-truth context the coder had.
 *   3. Append a tracked run to meta.json (so the UI shows it as a child
 *      of the coder's parentSessionId).
 *   4. Spawn the agent in the app's cwd via `spawnFreeSession`, await
 *      exit with a hard timeout, read the JSON verdict file the agent
 *      wrote, return the parsed payload.
 *   5. Manually flip the gate's run status (no `wireRunLifecycle`
 *      attached — that would recursively spawn another gate on the gate
 *      itself, and the gate is a read-only role anyway).
 *
 * The two callers differ only in playbook role name, verdict file name,
 * and verdict shape. The `runAgentGate` helper takes those as args.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { appendRun, updateRun, type Run } from "./meta";
import { getApp } from "./apps";
import { loadHouseRules } from "./houseRules";
import { topMemoryEntries } from "./memory";
import { loadPlaybook } from "./playbooks";
import { loadPinnedFiles } from "./pinnedFiles";
import { ensureFreshSymbolIndex } from "./symbolStore";
import { ensureFreshStyleFingerprint } from "./styleStore";
import { buildChildPrompt } from "./childPrompt";
import { spawnFreeSession } from "./spawn";
import {
  freeSessionSettingsPath,
  writeSessionSettings,
} from "./permissionSettings";
import { isAlreadyRetryRun } from "./verifyChain";
import { SESSIONS_DIR } from "./paths";

/** Cap how long any quality gate may run. 10 min matches the verify
 * chain default — any gate that goes longer is almost certainly stuck. */
export const GATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Magic exit codes our wait helper synthesizes for non-`exit` outcomes. */
const EXIT_TIMEOUT = -2;
const EXIT_SPAWN_ERR = -3;

/**
 * Wait for a child process to exit. Resolves with the OS exit code on a
 * clean exit, `EXIT_TIMEOUT` after `timeoutMs`, or `EXIT_SPAWN_ERR` if
 * the child fired `error` before exiting (binary missing, etc.).
 *
 * Always settles exactly once. Listeners are removed on settlement so
 * the child can be GC'd cleanly.
 */
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
      try { child.kill(); } catch { /* already dead */ }
      settle(EXIT_TIMEOUT);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Read the verdict JSON the gate agent wrote and JSON.parse it. Returns
 * `null` for any failure (file missing, non-JSON, parse error). The
 * caller validates shape — this helper keeps disk I/O concerns isolated.
 */
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
  /** Absolute cwd of the target app — the gate spawns here. */
  appPath: string;
  taskId: string;
  /** The just-finished run we're judging. */
  finishedRun: Run;
  /** Coordinator session id — for the gate's `parentSessionId`. Falls back to the run's parent. */
  taskTitle: string;
  taskBody: string;
  /** Role label (and playbook filename) for the gate agent. */
  role: string;
  /** One-line brief the bridge passes as the gate's task-specific body. */
  briefBody: string;
  /** Filename (under `sessions/<task>/`) where the gate must drop its verdict JSON. */
  verdictFileName: string;
  /** Hard timeout for the gate spawn. Defaults to GATE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type AgentGateOutcome =
  | { kind: "spawned"; sessionId: string; verdict: unknown }
  | { kind: "skipped"; reason: string; sessionId?: string };

/**
 * Run an agent-driven quality gate end-to-end. Returns either:
 *
 *   - `{ kind: "spawned", sessionId, verdict }` — gate completed cleanly,
 *     verdict is whatever JSON the agent dropped (caller validates).
 *   - `{ kind: "skipped", reason, sessionId? }` — preconditions failed
 *     OR the gate spawn / exec itself failed. The caller writes the
 *     `skipped` verdict to the parent run's meta. `sessionId` is only
 *     present when we got far enough to register a run for the gate.
 */
export async function runAgentGate(
  opts: AgentGateOptions,
): Promise<AgentGateOutcome> {
  const sessionsDir = join(SESSIONS_DIR, opts.taskId);

  // Skip retries / coordinator runs — gating a `-vretry` would
  // re-fire the whole loop, and a coordinator never produces a diff
  // we can judge.
  if (
    isAlreadyRetryRun(opts.finishedRun.role) ||
    opts.finishedRun.role === "coordinator"
  ) {
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
      reason: `playbook \`bridge/playbooks/${opts.role}.md\` is missing`,
    };
  }

  // Load the standard context bundle the coder saw — keeps the gate's
  // judgment grounded in the same ground truth (House style + Available
  // helpers + Pinned context, etc.).
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
  });

  // Track the gate run BEFORE spawning so a spawn failure leaves a
  // visible `failed` row instead of an orphan child. Parented to the
  // SAME coordinator the coder was — the gate is its sibling, not its
  // descendant, so the AgentTree can render it cleanly.
  await appendRun(sessionsDir, {
    sessionId,
    role: opts.role,
    repo: opts.finishedRun.repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: opts.finishedRun.parentSessionId ?? null,
  });

  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
  let childHandle;
  try {
    childHandle = spawnFreeSession(
      opts.appPath,
      prompt,
      { mode: "bypassPermissions" },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    await updateRun(sessionsDir, sessionId, {
      status: "failed",
      endedAt: new Date().toISOString(),
    });
    return {
      kind: "skipped",
      reason: `${opts.role} spawn failed: ${(e as Error).message}`,
      sessionId,
    };
  }

  // Manually manage exit — wireRunLifecycle would recursively trigger
  // postExitFlow on the gate itself.
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
    return { kind: "skipped", reason, sessionId };
  }

  const verdictPath = join(sessionsDir, opts.verdictFileName);
  const verdict = readVerdictFile(verdictPath);
  if (verdict === null) {
    return {
      kind: "skipped",
      reason: `${opts.role} did not write \`${opts.verdictFileName}\``,
      sessionId,
    };
  }

  return { kind: "spawned", sessionId, verdict };
}
