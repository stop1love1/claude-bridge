import type { Run } from "./meta";
import type { AppRetry } from "./apps";

export type RetryGate =
  | "crash"
  | "verify"
  | "claim"
  | "preflight"
  | "style"
  | "semantic";

export const MAX_RETRY_PER_GATE = 5;

export const DEFAULT_MAX_RETRIES_PER_TASK = 4;

export const DEFAULT_RETRY: Required<AppRetry> = {
  crash: 1,
  verify: 1,
  claim: 1,
  preflight: 1,
  style: 1,
  semantic: 1,
  totalCap: DEFAULT_MAX_RETRIES_PER_TASK,
};

interface GateMeta {
  suffix: string;
  label: string;
}

const GATE_TABLE: Record<RetryGate, GateMeta> = {
  crash:     { suffix: "-retry",   label: "crash retry" },
  verify:    { suffix: "-vretry",  label: "verify retry" },
  claim:     { suffix: "-cretry",  label: "claim retry" },
  preflight: { suffix: "-cretry",  label: "preflight retry" },
  style:     { suffix: "-stretry", label: "style retry" },
  semantic:  { suffix: "-svretry", label: "semantic retry" },
};

const SUFFIX_MATCH_ORDER: Array<{ gate: RetryGate; suffix: string }> = [
  { gate: "semantic",  suffix: "-svretry" },
  { gate: "style",     suffix: "-stretry" },
  { gate: "verify",    suffix: "-vretry"  },
  { gate: "claim",     suffix: "-cretry"  },
  { gate: "crash",     suffix: "-retry"   },
];

const TRAILING_DIGITS_RE = /(\d+)$/;

export interface ParsedRole {
  baseRole: string;
  gate: RetryGate | null;
  attempt: number;
}

export function parseRole(role: string): ParsedRole {
  let attempt = 1;
  let stripped = role;
  const digitMatch = role.match(TRAILING_DIGITS_RE);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= MAX_RETRY_PER_GATE) {
      stripped = role.slice(0, -digitMatch[1].length);
      attempt = n;
    }
  }

  for (const { gate, suffix } of SUFFIX_MATCH_ORDER) {
    if (stripped.endsWith(suffix)) {
      return {
        baseRole: stripped.slice(0, -suffix.length),
        gate,
        attempt,
      };
    }
  }
  return { baseRole: role, gate: null, attempt: 0 };
}

export function isAnyRetryRole(role: string): boolean {
  return parseRole(role).gate !== null;
}

export function totalRetriesInTask(meta: { runs: Run[] }): number {
  let total = 0;
  for (const r of meta.runs) {
    const n = r.retryAttempt;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

export function countRetryAttempts(
  meta: { runs: Run[] },
  parentSessionId: string | null | undefined,
  baseRole: string,
  gate: RetryGate,
): number {
  if (!parentSessionId) return 0;
  let count = 0;
  for (const r of meta.runs) {
    if (r.parentSessionId !== parentSessionId) continue;
    const parsed = parseRole(r.role);
    if (parsed.baseRole !== baseRole) continue;
    if (parsed.gate !== gate) {
      if (gate === "preflight" && parsed.gate === "claim") {
        count++;
      }
      continue;
    }
    count++;
  }
  return count;
}

export function nextRetryRole(
  baseRole: string,
  gate: RetryGate,
  nextAttempt: number,
): string {
  const { suffix } = GATE_TABLE[gate];
  if (nextAttempt <= 1) return `${baseRole}${suffix}`;
  return `${baseRole}${suffix}${nextAttempt}`;
}

export function maxAttemptsFor(retry: AppRetry | undefined, gate: RetryGate): number {
  const cfg = retry?.[gate];
  const fallback = DEFAULT_RETRY[gate];
  const n =
    typeof cfg === "number" && Number.isFinite(cfg) && cfg >= 0
      ? cfg
      : fallback;
  return Math.min(MAX_RETRY_PER_GATE, Math.max(0, Math.floor(n)));
}

export interface EligibilityArgs {
  finishedRun: Run;
  meta: { runs: Run[] };
  gate: RetryGate;
  retry: AppRetry | undefined;
}

export function totalCapFor(retry: AppRetry | undefined): number {
  const cfg = retry?.totalCap;
  if (typeof cfg === "number" && Number.isFinite(cfg) && cfg >= 0) {
    return Math.floor(cfg);
  }
  return DEFAULT_MAX_RETRIES_PER_TASK;
}

export interface EligibilityResult {
  eligible: boolean;
  nextAttempt: number;
  reason?: string;
}

export function checkEligibility(args: EligibilityArgs): EligibilityResult {
  const { finishedRun, meta, gate, retry } = args;

  if (!finishedRun.parentSessionId) {
    return { eligible: false, nextAttempt: 0, reason: "no parent session" };
  }

  const parsed = parseRole(finishedRun.role);

  if (parsed.gate !== null && parsed.gate !== gate) {
    const cretryShare = (parsed.gate === "claim" && gate === "preflight") ||
                        (parsed.gate === "preflight" && gate === "claim");
    if (!cretryShare) {
      return {
        eligible: false,
        nextAttempt: 0,
        reason: `cross-gate blocked: run is already a ${parsed.gate} retry, gate=${gate} cannot fire`,
      };
    }
  }

  const max = maxAttemptsFor(retry, gate);
  if (max === 0) {
    return { eligible: false, nextAttempt: 0, reason: `gate=${gate} disabled (max=0)` };
  }

  const totalCap = totalCapFor(retry);
  if (totalCap > 0) {
    const usedTotal = totalRetriesInTask(meta);
    if (usedTotal >= totalCap) {
      return {
        eligible: false,
        nextAttempt: 0,
        reason: `per-task ceiling reached: ${usedTotal}/${totalCap} retries already fired across all gates and chains`,
      };
    }
  }

  const fromMeta = countRetryAttempts(
    meta,
    finishedRun.parentSessionId,
    parsed.baseRole,
    gate,
  );
  const cretryShare = (gate === "preflight" && parsed.gate === "claim") ||
                      (gate === "claim" && parsed.gate === "preflight");
  const sameGate = parsed.gate === gate || cretryShare;
  const used = sameGate ? Math.max(fromMeta, parsed.attempt) : fromMeta;
  if (used >= max) {
    return {
      eligible: false,
      nextAttempt: 0,
      reason: `budget exhausted: ${used}/${max} attempts already`,
    };
  }

  return { eligible: true, nextAttempt: used + 1 };
}


export type RetryStrategy =
  | "same-context"
  | "fresh-focus"
  | "fixer-only";

export function strategyForAttempt(attempt: number): RetryStrategy {
  if (attempt <= 1) return "same-context";
  if (attempt === 2) return "fresh-focus";
  return "fixer-only";
}

export function renderStrategyPrefix(args: {
  gate: RetryGate;
  attempt: number;
  maxAttempts: number;
}): string {
  const { gate, attempt, maxAttempts } = args;
  const strategy = strategyForAttempt(attempt);
  const head = `## Retry attempt ${attempt} of ${maxAttempts} — gate: ${gate} — strategy: ${strategy}`;
  switch (strategy) {
    case "same-context":
      return [head, "", "Treat the failure context below as the source of truth and re-attempt the original brief.", ""].join("\n");
    case "fresh-focus":
      return [
        head,
        "",
        "Earlier attempts already received the full brief and failed. **Switch tactics:** ignore stylistic concerns, focus narrowly on the failure described below. Read the relevant files, fix the underlying issue, do NOT broaden scope.",
        "",
      ].join("\n");
    case "fixer-only":
      return [
        head,
        "",
        "**Final attempt.** Do not refactor, do not improve, do not explain. Make the smallest possible change that resolves the failure described below. If you cannot identify a minimal fix in 1–2 file edits, exit with verdict `NEEDS-DECISION` and surface the blocker in `## Questions for the user` — do not gamble on speculative fixes.",
        "",
      ].join("\n");
  }
}

export function describeRetry(gate: RetryGate, attempt: number, max: number): string {
  return `${GATE_TABLE[gate].label} ${attempt}/${max}`;
}
