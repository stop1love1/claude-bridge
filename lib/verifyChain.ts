/**
 * P2 — verify chain runner + auto-retry on verify failure.
 *
 * After a child agent exits cleanly, the lifecycle hook (`coordinator.ts:
 * succeedRun`) calls `runVerifyChain` against the configured commands in
 * `app.verify`. Steps run sequentially in canonical order
 * (`format → lint → typecheck → test → build`); the chain stops on the
 * first failing step. The full per-step result is persisted onto the
 * `Run.verify` field via a single `updateRun` call (combined with the
 * status flip to dodge the read-modify-write race documented in
 * `meta.ts`).
 *
 * On failure, `spawnVerifyRetry` mirrors the `childRetry.ts` direct-spawn
 * pattern: same parent (the coordinator) so attempts render as siblings,
 * a distinct `-vretry` role suffix so the retry budget never collides
 * with the crash-retry path's `-retry` suffix, and the raw failing
 * step's stdout+stderr injected at the top of the prompt so the model
 * sees the ground-truth error before re-reading the original brief.
 */
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { App, AppVerify } from "./apps";
import { appendRun, type Run, type RunVerify, type RunVerifyStep } from "./meta";
import { wireRunLifecycle } from "./coordinator";
import { resolveRepoCwd } from "./repos";
import { spawnFreeSession } from "./spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "./permissionSettings";
import { readOriginalPrompt } from "./promptStore";
import { inheritWorktreeFields } from "./worktrees";
import { BRIDGE_MD, BRIDGE_ROOT, SESSIONS_DIR } from "./paths";

/** Canonical order — matches the `## Verify commands` section in childPrompt. */
const STEP_ORDER: RunVerifyStep["name"][] = [
  "format",
  "lint",
  "typecheck",
  "test",
  "build",
];

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OUTPUT_CAP_BYTES = 16 * 1024;
const VRETRY_SUFFIX = "-vretry";

export interface RunVerifyChainOptions {
  cwd: string;
  verify: AppVerify;
  timeoutMs?: number;
  outputCapBytes?: number;
  /** Optional hook for callers that want per-step start/end notifications. */
  onStep?: (phase: "start" | "end", step: RunVerifyStep) => void;
}

/**
 * True iff the AppVerify object has at least one non-empty command.
 * Avoids running the chain (and writing an empty `verify` field) when
 * the app hasn't opted in.
 */
export function hasAnyVerifyCommand(v: AppVerify | null | undefined): boolean {
  if (!v) return false;
  return STEP_ORDER.some((name) => {
    const cmd = v[name];
    return typeof cmd === "string" && cmd.trim().length > 0;
  });
}

/**
 * Execute every configured verify step in canonical order, stopping on
 * first failure. Steps with no command in the AppVerify config are
 * silently skipped (no entry in the result, keeping meta.json terse).
 */
export async function runVerifyChain(
  opts: RunVerifyChainOptions,
): Promise<RunVerify> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputCap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;

  const startedAt = new Date().toISOString();
  const steps: RunVerifyStep[] = [];

  for (const name of STEP_ORDER) {
    const cmd = opts.verify[name];
    if (typeof cmd !== "string" || cmd.trim().length === 0) continue;
    const trimmed = cmd.trim();

    const startStep: RunVerifyStep = {
      name,
      cmd: trimmed,
      ok: false,
      exitCode: null,
      durationMs: 0,
      output: "",
    };
    opts.onStep?.("start", startStep);

    const result = await execStep(trimmed, opts.cwd, timeoutMs, outputCap);
    const finished: RunVerifyStep = {
      name,
      cmd: trimmed,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.output,
    };
    steps.push(finished);
    opts.onStep?.("end", finished);

    // Stop on first failing step — downstream steps would only add
    // noise and burn time on a tree that's already broken.
    if (!finished.ok) break;
  }

  return {
    steps,
    // Empty step list means the app configured no commands — that's
    // "nothing to verify, nothing failed", not a failure. Callers that
    // need to gate on "did we actually run any checks?" should branch
    // on `steps.length`. The live commit-gate path in coordinator.ts
    // is already protected by `hasAnyVerifyCommand` upstream so this
    // never matters there, but direct callers shouldn't be surprised.
    passed: steps.every((s) => s.ok),
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  /** Combined stdout + stderr, capped + with truncation marker on overflow. */
  output: string;
}

/**
 * Run a single shell command, capturing combined stdout+stderr capped at
 * `outputCap` bytes. Uses `spawn(..., { shell: true })` so user-supplied
 * commands like `bun test --reporter=verbose` work unmodified across
 * platforms — Node delegates to `cmd /c` on Windows and `sh -c` on POSIX.
 *
 * Hard timeout via AbortController. On Windows, killing the shell does
 * NOT always reap grandchild processes — we accept this as a known
 * limitation (Risk 3 in the explorer report) and document the recommended
 * `verify` shape (commands that respect SIGTERM / completion signals).
 */
function execStep(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  outputCap: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const start = Date.now();
    const ac = new AbortController();
    const spawnOpts: SpawnOptionsWithoutStdio = {
      cwd,
      shell: true,
      windowsHide: true,
      signal: ac.signal,
    };

    let child;
    try {
      child = spawn(cmd, [], spawnOpts);
    } catch (err) {
      resolve({
        exitCode: null,
        durationMs: Date.now() - start,
        output: `(bridge: spawn failed — ${(err as Error).message})`,
      });
      return;
    }

    let collected = "";
    let truncated = false;
    const append = (chunk: Buffer) => {
      if (truncated) return;
      const remaining = outputCap - Buffer.byteLength(collected, "utf8");
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      if (Buffer.byteLength(text, "utf8") <= remaining) {
        collected += text;
      } else {
        // Trim at a UTF-8 safe boundary by re-encoding the slice.
        const buf = Buffer.from(text, "utf8").subarray(0, remaining);
        collected += buf.toString("utf8");
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      ac.abort();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const settle = (exitCode: number | null, suffixNote?: string) => {
      clearTimeout(timer);
      let output = collected;
      if (truncated) {
        output += `\n\n…(bridge: output truncated at ${outputCap} bytes)`;
      }
      if (suffixNote) {
        output += (output ? "\n\n" : "") + suffixNote;
      }
      resolve({ exitCode, durationMs: Date.now() - start, output });
    };

    child.once("error", (err) => {
      const aborted = (err as NodeJS.ErrnoException).name === "AbortError";
      settle(
        null,
        aborted
          ? `(bridge: aborted after ${timeoutMs}ms timeout)`
          : `(bridge: child error — ${err.message})`,
      );
    });
    child.once("exit", (code) => {
      // When AbortController fires, "exit" still arrives with a non-zero
      // code — surface the timeout marker either way.
      settle(code, ac.signal.aborted ? `(bridge: aborted after ${timeoutMs}ms timeout)` : undefined);
    });
  });
}

/**
 * True iff the run is a retry already (any flavour), so the lifecycle
 * hook should NOT spawn another follow-up. Five suffixes map here:
 *
 *   - `-retry`    crash retry from `lib/childRetry.ts`
 *   - `-vretry`   verify-fail retry from this module
 *   - `-cretry`   claim-vs-diff retry from `lib/verifier.ts`
 *   - `-stretry`  style-critic retry from `lib/styleCritic.ts`
 *   - `-svretry`  semantic-verifier retry from `lib/semanticVerifier.ts`
 *
 * No retry of any flavour gets a second retry of any kind — one extra
 * attempt per failure mode is the documented cap.
 *
 * NOTE: `-svretry` ends in `-vretry`, so order matters in the matcher
 * (or rather, doesn't, since either match is a retry). The literal
 * suffix tests below tolerate both substrings safely.
 */
export function isAlreadyRetryRun(role: string): boolean {
  return (
    role.endsWith("-retry") ||
    role.endsWith(VRETRY_SUFFIX) ||
    role.endsWith("-cretry") ||
    role.endsWith("-stretry") ||
    role.endsWith("-svretry")
  );
}

/**
 * Render the retry-context block that gets prepended to the original
 * prompt. Mirrors `childRetry.renderRetryContextBlock` shape (same
 * `## Auto-retry context — what failed last time` heading) so the model
 * has consistent contract regardless of whether the retry was triggered
 * by a crash or a verify failure.
 */
export function renderVerifyRetryContextBlock(verify: RunVerify): string {
  const failedStep = verify.steps.find((s) => !s.ok);
  const passed = verify.steps.filter((s) => s.ok).map((s) => s.name);

  const lines: string[] = [
    "## Auto-retry context — what failed last time",
    "",
    "The previous attempt exited cleanly, but the bridge's verify chain rejected the work. Read the failing step output below — it is the source of truth, not your prior assistant message.",
    "",
  ];

  if (failedStep) {
    const exitStr =
      failedStep.exitCode === null
        ? "non-zero (no code captured — likely timeout / spawn error)"
        : String(failedStep.exitCode);
    lines.push(
      `### Failed step: \`${failedStep.name}\` (exit ${exitStr})`,
      `Command: \`${failedStep.cmd}\``,
      "",
      "```",
      failedStep.output || "(no output captured)",
      "```",
      "",
    );
  } else {
    lines.push("### Failed step: (none recorded — chain produced no entries)", "");
  }

  if (passed.length > 0) {
    lines.push(
      "### Steps that already passed",
      ...passed.map((n) => `- \`${n}\` ✓`),
      "",
    );
  }

  lines.push(
    "Fix the underlying issue, not just the symptom. After your fix, re-run the failing command yourself to confirm before exiting. The bridge will re-run the full verify chain on this attempt — passing it gates the auto-commit.",
    "",
  );
  return lines.join("\n");
}

/**
 * Spawn a verify-retry. Mirrors `childRetry.spawnRetryRun`: direct
 * `spawnFreeSession` call (no HTTP self-loop), inherits the failed
 * run's `parentSessionId` so the new run renders as a sibling under the
 * same coordinator, role gets the `-vretry` suffix to keep the retry
 * budget separate from crash retries.
 */
export async function spawnVerifyRetry(args: {
  taskId: string;
  finishedRun: Run;
  verify: RunVerify;
}): Promise<{ sessionId: string; run: Run } | null> {
  const { taskId, finishedRun, verify } = args;
  const sessionsDir = join(SESSIONS_DIR, taskId);

  let md: string;
  try {
    md = readFileSync(BRIDGE_MD, "utf8");
  } catch {
    return null;
  }
  const liveRepoCwd = resolveRepoCwd(md, BRIDGE_ROOT, finishedRun.repo);
  if (!liveRepoCwd) return null;
  // P4/F1: retries inherit the parent's worktree so they edit the same
  // sandbox the original run started in.
  const spawnCwd = finishedRun.worktreePath ?? liveRepoCwd;

  const ctxBlock = renderVerifyRetryContextBlock(verify);
  const originalPrompt = readOriginalPrompt(taskId, finishedRun);
  const body =
    originalPrompt.trim() ||
    "(original prompt unavailable — repo state and the failure context above are the only signals you have. Inspect the repo, infer the intent, and try to make forward progress.)";
  const retryPrompt = [ctxBlock, "---", "", body].join("\n");

  const sessionId = randomUUID();
  const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));

  let childHandle;
  try {
    childHandle = spawnFreeSession(
      spawnCwd,
      retryPrompt,
      { mode: "bypassPermissions" },
      settingsPath,
      sessionId,
    );
  } catch (e) {
    console.error("verify-retry spawn failed for", taskId, finishedRun.sessionId, e);
    return null;
  }

  const retryRun: Run = {
    sessionId,
    role: `${finishedRun.role}${VRETRY_SUFFIX}`,
    repo: finishedRun.repo,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    parentSessionId: finishedRun.parentSessionId ?? null,
    retryOf: finishedRun.sessionId,
    ...inheritWorktreeFields(finishedRun),
  };
  // Async per-task lock: must await before wiring lifecycle so an
  // early `exit` from the freshly-spawned child can't fire updateRun
  // against a sessionId not yet visible in meta.json.
  await appendRun(sessionsDir, retryRun);
  wireRunLifecycle(
    sessionsDir,
    sessionId,
    childHandle.child,
    `verify-retry ${taskId}/${sessionId}`,
  );
  return { sessionId, run: retryRun };
}

/**
 * Eligibility for verify-driven retry. Stricter than crash-retry
 * (`childRetry.isEligibleForRetry`):
 *
 * - Must have a parent (no coordinator-level verify retries)
 * - Must NOT already be a retry of any kind (`-retry` or `-vretry`)
 * - No prior `-vretry` sibling already in meta.json
 *
 * Crash-retry siblings (`-retry`) DO NOT block a fresh verify-retry —
 * the two budgets are intentionally independent because they target
 * different failure modes.
 */
export function isEligibleForVerifyRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
}): boolean {
  const { finishedRun, meta } = args;
  if (!finishedRun.parentSessionId) return false;
  if (isAlreadyRetryRun(finishedRun.role)) return false;
  const expected = `${finishedRun.role}${VRETRY_SUFFIX}`;
  const prior = meta.runs.find(
    (r) =>
      r.parentSessionId === finishedRun.parentSessionId &&
      r.role === expected,
  );
  return !prior;
}

/**
 * Re-export for callers that want the suffix string without re-stating
 * the magic constant. Rare — most code should use the helpers above.
 */
export const VERIFY_RETRY_SUFFIX = VRETRY_SUFFIX;

/**
 * Pull the configured verify shape off an App. Trivial wrapper, but it
 * makes the callsite in coordinator.ts read cleanly and gives us a
 * single seam to inject mocks in tests.
 */
export function verifyConfigOf(app: App | null): AppVerify | null {
  return app?.verify ?? null;
}
