import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { type App, type AppVerify } from "./apps";
import { type Run, type RunVerify, type RunVerifyStep } from "./meta";
import { treeKill } from "./processKill";
import { spawnRetry } from "./retrySpawn";
import {
  checkEligibility,
  isAnyRetryRole,
} from "./retryLadder";

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
  onStep?: (phase: "start" | "end", step: RunVerifyStep) => void;
}

export function hasAnyVerifyCommand(v: AppVerify | null | undefined): boolean {
  if (!v) return false;
  return STEP_ORDER.some((name) => {
    const cmd = v[name];
    return typeof cmd === "string" && cmd.trim().length > 0;
  });
}

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

    if (!finished.ok) break;
  }

  return {
    steps,
    passed: steps.every((s) => s.ok),
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  output: string;
}

const KILL_GRACE_MS = 2000;

function execStep(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  outputCap: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const start = Date.now();
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

export function isAlreadyRetryRun(role: string): boolean {
  return isAnyRetryRole(role);
}

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

export const VERIFY_RETRY_SUFFIX = VRETRY_SUFFIX;

export function verifyConfigOf(app: App | null): AppVerify | null {
  return app?.verify ?? null;
}
