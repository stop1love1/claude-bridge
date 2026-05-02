// Package retry centralizes the multi-strategy retry-ladder logic the
// bridge runs after a child agent exits. Pure logic only — suffix
// detection, attempt counting, role generation, eligibility checks,
// per-attempt strategy selection. The orchestration layer (worktrees,
// LLM-driven memory, child spawn) lives elsewhere; this package is
// reachable from a unit test with no I/O.
//
// Five gates share one ladder:
//
//	gate            suffix       AppRetry key
//	─────           ──────       ────────────
//	crash           -retry       crash
//	verify          -vretry      verify
//	claim           -cretry      claim
//	preflight       -cretry*     preflight
//	style           -stretry     style
//	semantic        -svretry     semantic
//
//	* preflight piggy-backs on the -cretry suffix because both gates
//	  are claim-shaped agent-process drift; one shared budget covers
//	  either failure mode (legacy behavior preserved).
//
// Suffix scheme for attempt N:
//
//	N=1 → <base><suffix>        (e.g. coder-vretry)   ── unchanged
//	N=2 → <base><suffix>2       (e.g. coder-vretry2)
//	N=3 → <base><suffix>3       (e.g. coder-vretry3)
//
// Cross-gate retries are blocked: once a run carries a retry suffix,
// only same-gate follow-ups can fire. Prevents runaway retry trees
// like coder-vretry-cretry-stretry.
//
// Ported from libs/retryLadder.ts in S08-retry-ladder. Note: the TS
// module imports AppRetry from libs/apps; the Go internal/apps package
// has not yet exported a typed retry config (retry budgets still live
// inside App.Extras as raw JSON). To keep this port self-contained we
// declare AppRetry locally with the same shape; once internal/apps
// exposes a typed RetrySettings the alias can collapse.
package retry
