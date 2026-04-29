/**
 * Multi-strategy retry ladder — Gap 2.
 *
 * Centralizes retry-suffix detection, attempt counting, role generation,
 * and per-attempt strategy hints across the 5 retry paths the bridge
 * runs after a child agent exits:
 *
 *   gate            module                 suffix       AppRetry key
 *   ─────           ──────                 ──────       ────────────
 *   crash           lib/childRetry.ts      `-retry`     crash
 *   verify          lib/verifyChain.ts     `-vretry`    verify
 *   claim-vs-diff   lib/verifier.ts        `-cretry`    claim
 *   preflight       lib/preflightCheck.ts  `-cretry`*   preflight
 *   style critic    lib/styleCritic.ts     `-stretry`   style
 *   semantic verif. lib/semanticVerifier.ts `-svretry`  semantic
 *
 *   * preflight piggy-backs on the `-cretry` suffix because both gates
 *     are claim-shaped agent-process drift; one shared budget covers
 *     either failure mode (legacy behavior preserved).
 *
 * Each gate has an independent budget, configured per-app via
 * `bridge.json.apps[].retry.<gate>` (capped by `MAX_RETRY_PER_GATE`).
 * Default 1 = current behavior, fully back-compat.
 *
 * Suffix scheme for attempt N:
 *   N=1 → `<base><suffix>`        (e.g. `coder-vretry`) ── unchanged
 *   N=2 → `<base><suffix>2`       (e.g. `coder-vretry2`)
 *   N=3 → `<base><suffix>3`       (e.g. `coder-vretry3`)
 *
 * Cross-gate retries are blocked: once a run carries a retry suffix,
 * only same-gate follow-ups can fire. Prevents runaway retry trees like
 * `coder-vretry-cretry-stretry`.
 */
import type { Run } from "./meta";
import type { AppRetry } from "./apps";

/** Canonical gate identifiers used everywhere across the retry layer. */
export type RetryGate =
  | "crash"
  | "verify"
  | "claim"
  | "preflight"
  | "style"
  | "semantic";

/** Maximum attempts per gate, regardless of operator config. Above this
 *  the ladder caps silently — runaway retries cost both tokens and time. */
export const MAX_RETRY_PER_GATE = 5;

/** Default budget per gate when the operator hasn't configured `retry`. */
export const DEFAULT_RETRY: Required<AppRetry> = {
  crash: 1,
  verify: 1,
  claim: 1,
  preflight: 1,
  style: 1,
  semantic: 1,
};

interface GateMeta {
  /** Suffix string (with leading dash). */
  suffix: string;
  /** Human label used in log messages. */
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

/**
 * Order matters: longer suffixes first so `-svretry` is matched before
 * `-vretry` (the latter is a substring). Same reason `-stretry` before
 * `-retry`. Once we find any match we stop.
 */
const SUFFIX_MATCH_ORDER: Array<{ gate: RetryGate; suffix: string }> = [
  { gate: "semantic",  suffix: "-svretry" },
  { gate: "style",     suffix: "-stretry" },
  { gate: "verify",    suffix: "-vretry"  },
  { gate: "claim",     suffix: "-cretry"  },
  { gate: "crash",     suffix: "-retry"   },
];

/** Trailing digit (the attempt number for N≥2 retries). */
const TRAILING_DIGITS_RE = /(\d+)$/;

export interface ParsedRole {
  /** Role with all retry suffixes + numbers stripped. E.g. `coder-vretry2 → coder`. */
  baseRole: string;
  /** Gate this role is a retry of, or `null` if it's a base run. */
  gate: RetryGate | null;
  /** Attempt number — 0 for base runs, ≥1 for retries. */
  attempt: number;
}

/**
 * Parse a role string into its base + gate + attempt components.
 *
 * Examples:
 *   `coder`           → { baseRole: "coder", gate: null, attempt: 0 }
 *   `coder-vretry`    → { baseRole: "coder", gate: "verify", attempt: 1 }
 *   `coder-vretry2`   → { baseRole: "coder", gate: "verify", attempt: 2 }
 *   `coder-stretry3`  → { baseRole: "coder", gate: "style",  attempt: 3 }
 *
 * Note: the `claim` gate and `preflight` gate share the `-cretry`
 * suffix, so parsing always reports `gate: "claim"` for that suffix.
 * Callers that need to disambiguate (rare — only the eligibility check
 * cares) carry the gate explicitly via the calling-site argument.
 */
export function parseRole(role: string): ParsedRole {
  // Strip any trailing digits first so the suffix match works on
  // `coder-vretry2` → `coder-vretry`.
  let attempt = 1;
  let stripped = role;
  const digitMatch = role.match(TRAILING_DIGITS_RE);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n >= 2 && n <= MAX_RETRY_PER_GATE) {
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
  // No suffix → base run; trailing digits in the role are NOT a retry
  // counter, they're part of the role itself (e.g. `coder-v2`). Restore
  // the original role.
  return { baseRole: role, gate: null, attempt: 0 };
}

/**
 * True iff the role is any flavour of retry. Used by every gate's
 * eligibility helper to short-circuit cross-gate retries — if you're
 * already a `-vretry`, only verify-retries can fire on you.
 */
export function isAnyRetryRole(role: string): boolean {
  return parseRole(role).gate !== null;
}

/**
 * Count how many retry attempts already exist for a given (parent,
 * baseRole, gate) tuple. Includes the attempt currently finishing
 * if and only if `finishedRun.role` itself matches the gate.
 *
 * The count is over runs whose `parsedRole` matches the queried
 * baseRole + gate, regardless of their status — a queued/running
 * sibling counts toward the budget, otherwise concurrent triggers
 * could exceed the cap.
 */
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
      // Special case: preflight + claim share the `-cretry` suffix, so
      // parseRole reports `claim` for both. When the caller asked about
      // `preflight`, the existing `claim`-tagged sibling counts for our
      // budget too (same shared retry slot in legacy behavior).
      if (gate === "preflight" && parsed.gate === "claim") {
        count++;
      }
      continue;
    }
    count++;
  }
  return count;
}

/**
 * Generate the role string for the next retry attempt of `gate` against
 * `baseRole`. `nextAttempt=1` reproduces the legacy unsuffixed-number
 * format (`coder-vretry`); ≥2 appends the digit.
 */
export function nextRetryRole(
  baseRole: string,
  gate: RetryGate,
  nextAttempt: number,
): string {
  const { suffix } = GATE_TABLE[gate];
  if (nextAttempt <= 1) return `${baseRole}${suffix}`;
  return `${baseRole}${suffix}${nextAttempt}`;
}

/**
 * Read the per-app max attempts for a gate, clamped into
 * [0, MAX_RETRY_PER_GATE]. 0 = retries disabled for that gate.
 */
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
  /** Per-app retry config, may be undefined when no app or no override. */
  retry: AppRetry | undefined;
}

export interface EligibilityResult {
  /** True iff a retry of `gate` can be spawned for `finishedRun`. */
  eligible: boolean;
  /** The next retry's attempt number (1, 2, 3, …) — only meaningful when eligible. */
  nextAttempt: number;
  /** When ineligible: short reason for the log line. */
  reason?: string;
}

/**
 * Generic eligibility check shared by every gate. Replaces the 5 nearly-
 * identical `isEligibleForXRetry` functions; each module now passes
 * `gate: <its gate>` to this helper.
 *
 * Rules:
 *   1. Must have a parent (no coordinator-level retries).
 *   2. Must be either base OR same-gate retry (no cross-gate compounding).
 *   3. Existing attempts for (parent, baseRole, gate) < maxAttemptsFor(gate).
 */
export function checkEligibility(args: EligibilityArgs): EligibilityResult {
  const { finishedRun, meta, gate, retry } = args;

  if (!finishedRun.parentSessionId) {
    return { eligible: false, nextAttempt: 0, reason: "no parent session" };
  }

  const parsed = parseRole(finishedRun.role);

  // Cross-gate block: a finished retry of gate A cannot trigger gate B.
  // Same-gate retries chain freely up to the budget. preflight+claim share
  // a slot, so allow either to chain into the other (legacy behavior).
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

  const fromMeta = countRetryAttempts(
    meta,
    finishedRun.parentSessionId,
    parsed.baseRole,
    gate,
  );
  // The finishedRun is itself the Nth attempt of `gate` when its role
  // already carries this gate's suffix (or the shared cretry slot).
  // Take MAX of the meta-derived count and the parsed attempt number so
  // a caller passing `meta: { runs: [] }` (test fixture, mid-write meta)
  // still gets the correct used-count from the role string alone.
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

/* ────────────────────────────────────────────────────────────────────
 *  Strategy registry — varies retry prompt shape by attempt number
 * ────────────────────────────────────────────────────────────────────
 */

/** Identifier for the prompt-shape used by an individual retry attempt. */
export type RetryStrategy =
  | "same-context"      // attempt 1 — full original prompt + failure context
  | "fresh-focus"       // attempt 2 — strip retry chatter, focus on the failure
  | "fixer-only";       // attempt 3+ — narrowest scope, "fix this exact thing"

/**
 * Pick the strategy for attempt N. Same ladder for every gate:
 *   N=1 → same-context  (full original prompt + auto-retry context block)
 *   N=2 → fresh-focus   (task body + failure only, drop verbose lead-ins)
 *   N=3+ → fixer-only   (one-line directive; no exposition)
 */
export function strategyForAttempt(attempt: number): RetryStrategy {
  if (attempt <= 1) return "same-context";
  if (attempt === 2) return "fresh-focus";
  return "fixer-only";
}

/**
 * Render a prefix line that primes the agent for the chosen strategy.
 * Each retry's existing prompt builder prepends this BEFORE its gate-
 * specific failure context block, so attempt 2+ runs open with explicit
 * "this is attempt N of M, switch tactics" framing.
 */
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

/**
 * Optional helper: callers that want to log "spawned attempt N" use
 * this to format the message uniformly.
 */
export function describeRetry(gate: RetryGate, attempt: number, max: number): string {
  return `${GATE_TABLE[gate].label} ${attempt}/${max}`;
}
