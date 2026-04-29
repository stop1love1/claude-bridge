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
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { type App, type AppVerify } from "./apps";
import { type Run, type RunVerify, type RunVerifyStep } from "./meta";
import { treeKill } from "./processKill";
import { spawnRetry } from "./retrySpawn";
import {
  checkEligibility,
  isAnyRetryRole,
} from "./retryLadder";

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
 * Hard timeout uses `treeKill` so the entire process subtree is reaped
 * on Windows (where `child.kill()` only terminates `cmd.exe`, leaving
 * grandchildren like `bun test` running). The previous AbortController
 * approach orphaned grandchildren — see `libs/processKill.ts` for the
 * platform-specific reasoning. After SIGTERM we schedule a SIGKILL
 * backstop in case the runner ignores polite termination.
 */
const KILL_GRACE_MS = 2000;

function execStep(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  outputCap: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const start = Date.now();
    // Defensive sanity check: reject NUL bytes and embedded newlines
    // before they reach the shell. Real verify commands are single-line
    // (`bun test`, `pnpm lint`, …); a multi-line value almost always
    // means a paste accident — and on Windows in particular, a stray
    // newline can re-enter `cmd.exe` parsing in surprising ways.
    if (cmd.includes("\0") || cmd.includes("\n") || cmd.includes("\r")) {
      resolve({
        exitCode: null,
        durationMs: 0,
        output:
          "(bridge: refused to run verify command containing NUL or newline characters)",
      });
      return;
    }
    const spawnOpts: SpawnOptionsWithoutStdio = {
      cwd,
      shell: true,
      windowsHide: true,
    };

    let child: ChildProcessWithoutNullStreams;
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

    let timedOut = false;
    let killBackstop: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child, "SIGTERM");
      // Grandchildren that ignore SIGTERM (rare but possible — long
      // teardown hooks, swallow handlers) get a hard SIGKILL.
      killBackstop = setTimeout(() => treeKill(child, "SIGKILL"), KILL_GRACE_MS);
      if (typeof killBackstop.unref === "function") killBackstop.unref();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const settle = (exitCode: number | null, suffixNote?: string) => {
      clearTimeout(timer);
      if (killBackstop) clearTimeout(killBackstop);
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
      settle(null, `(bridge: child error — ${err.message})`);
    });
    child.once("exit", (code) => {
      settle(code, timedOut ? `(bridge: aborted after ${timeoutMs}ms timeout)` : undefined);
    });
  });
}

/**
 * True iff the run is a retry already (any flavour). Now defers to
 * `retryLadder.isAnyRetryRole` so numbered suffixes (e.g. `-vretry2`)
 * are detected too. Kept exported under its old name because every
 * other retry module imports it from here.
 */
export function isAlreadyRetryRun(role: string): boolean {
  return isAnyRetryRole(role);
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
  return spawnRetry({
    taskId: args.taskId,
    finishedRun: args.finishedRun,
    gate: "verify",
    ctxBlock: renderVerifyRetryContextBlock(args.verify),
    logLabel: "verify-retry",
  });
}

/**
 * Eligibility for verify-driven retry. Delegates to the central ladder:
 * counts existing `-vretry*` siblings against the per-app budget
 * (`app.retry.verify`, default 1). Same-gate retries chain up to the
 * cap; cross-gate retries (e.g. a `-cretry` run) are blocked.
 *
 * Crash-retry siblings (`-retry`) DO NOT count toward this budget —
 * the gates are independent.
 */
export function isEligibleForVerifyRetry(args: {
  finishedRun: Run;
  meta: { runs: Run[] };
  retry?: import("./apps").AppRetry;
}): boolean {
  return checkEligibility({
    finishedRun: args.finishedRun,
    meta: args.meta,
    gate: "verify",
    retry: args.retry,
  }).eligible;
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
