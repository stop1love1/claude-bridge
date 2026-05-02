package retry

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// Gate is a canonical retry-gate identifier used across the retry layer.
type Gate string

const (
	GateCrash     Gate = "crash"
	GateVerify    Gate = "verify"
	GateClaim     Gate = "claim"
	GatePreflight Gate = "preflight"
	GateStyle     Gate = "style"
	GateSemantic  Gate = "semantic"
)

// MaxRetryPerGate is the hard cap on attempts per gate, regardless of
// operator config. Above this the ladder caps silently — runaway
// retries cost both tokens and time.
const MaxRetryPerGate = 5

// AppRetry mirrors libs/apps.ts AppRetry (per-gate budget overrides
// from bridge.json.apps[].retry). Pointer fields keep "unset" distinct
// from "0 attempts" — the TS code uses Required<AppRetry> with
// undefined-checks for the same purpose. See doc.go for why this is
// declared here instead of in internal/apps.
type AppRetry struct {
	Crash     *int `json:"crash,omitempty"`
	Verify    *int `json:"verify,omitempty"`
	Claim     *int `json:"claim,omitempty"`
	Preflight *int `json:"preflight,omitempty"`
	Style     *int `json:"style,omitempty"`
	Semantic  *int `json:"semantic,omitempty"`
}

// DefaultRetry is the per-gate budget when the operator hasn't set
// `retry` on the app. 1 = legacy single-retry behavior.
var DefaultRetry = map[Gate]int{
	GateCrash:     1,
	GateVerify:    1,
	GateClaim:     1,
	GatePreflight: 1,
	GateStyle:     1,
	GateSemantic:  1,
}

type gateMeta struct {
	suffix string // leading dash included
	label  string // human-readable for log lines
}

var gateTable = map[Gate]gateMeta{
	GateCrash:     {suffix: "-retry", label: "crash retry"},
	GateVerify:    {suffix: "-vretry", label: "verify retry"},
	GateClaim:     {suffix: "-cretry", label: "claim retry"},
	GatePreflight: {suffix: "-cretry", label: "preflight retry"},
	GateStyle:     {suffix: "-stretry", label: "style retry"},
	GateSemantic:  {suffix: "-svretry", label: "semantic retry"},
}

// suffixMatchOrder lists suffixes longest-first so substring suffixes
// don't shadow longer ones (-svretry must be checked before -vretry,
// -stretry before -retry). The first match wins.
var suffixMatchOrder = []struct {
	gate   Gate
	suffix string
}{
	{GateSemantic, "-svretry"},
	{GateStyle, "-stretry"},
	{GateVerify, "-vretry"},
	{GateClaim, "-cretry"},
	{GateCrash, "-retry"},
}

// trailingDigitsRE captures the attempt number on suffixed roles like
// `coder-vretry2`. Anchored at end-of-string.
var trailingDigitsRE = regexp.MustCompile(`(\d+)$`)

// ParsedRole is the decomposition of a role string into base + gate +
// attempt. Gate == "" means the role is a base run (not a retry).
type ParsedRole struct {
	BaseRole string // role with all retry suffixes + numbers stripped
	Gate     Gate   // empty when not a retry
	Attempt  int    // 0 for base runs, ≥1 for retries
}

// IsRetry reports whether the parsed role is any flavour of retry.
func (p ParsedRole) IsRetry() bool { return p.Gate != "" }

// ParseRole decomposes a role string. Examples:
//
//	coder           → {BaseRole: "coder", Gate: "",       Attempt: 0}
//	coder-vretry    → {BaseRole: "coder", Gate: "verify", Attempt: 1}
//	coder-vretry2   → {BaseRole: "coder", Gate: "verify", Attempt: 2}
//	coder-stretry3  → {BaseRole: "coder", Gate: "style",  Attempt: 3}
//
// The claim and preflight gates share -cretry, so this always reports
// `claim` for that suffix; eligibility callers that need to distinguish
// pass the gate explicitly.
func ParseRole(role string) ParsedRole {
	// Strip trailing digits before suffix-matching so `coder-vretry2`
	// reduces to `coder-vretry` for the suffix loop. Convention is
	// N=1 → no digit suffix, but accept N=1 explicitly so a future
	// caller normalizing to `coder-vretry1` still parses correctly —
	// without this guard the literal "1" would silently miss the
	// suffix loop and mis-classify a real retry as a base run.
	attempt := 1
	stripped := role
	if m := trailingDigitsRE.FindString(role); m != "" {
		if n, err := strconv.Atoi(m); err == nil && n >= 1 && n <= MaxRetryPerGate {
			stripped = role[:len(role)-len(m)]
			attempt = n
		}
	}

	for _, s := range suffixMatchOrder {
		if strings.HasSuffix(stripped, s.suffix) {
			return ParsedRole{
				BaseRole: stripped[:len(stripped)-len(s.suffix)],
				Gate:     s.gate,
				Attempt:  attempt,
			}
		}
	}
	// No suffix → base run; the trailing digits we peeled (if any) are
	// not a retry counter, they're part of the role name (e.g. `coder-v2`).
	// Restore the original role.
	return ParsedRole{BaseRole: role, Gate: "", Attempt: 0}
}

// IsAnyRetryRole is true iff role carries any retry suffix.
func IsAnyRetryRole(role string) bool {
	return ParseRole(role).IsRetry()
}

// NextRetryRole builds the role string for attempt nextAttempt of gate
// against baseRole. nextAttempt ≤ 1 emits the legacy un-numbered shape
// (`coder-vretry`); ≥ 2 appends the digit.
func NextRetryRole(baseRole string, gate Gate, nextAttempt int) string {
	g, ok := gateTable[gate]
	if !ok {
		// Unknown gate — return the bare base. Defensive only; callers
		// always pass a defined Gate constant.
		return baseRole
	}
	if nextAttempt <= 1 {
		return baseRole + g.suffix
	}
	return baseRole + g.suffix + strconv.Itoa(nextAttempt)
}

// MaxAttemptsFor reads the per-app budget for gate, clamped into
// [0, MaxRetryPerGate]. 0 = retries disabled for that gate.
func MaxAttemptsFor(retry *AppRetry, gate Gate) int {
	cfg := gateConfig(retry, gate)
	fallback := DefaultRetry[gate]
	n := fallback
	if cfg != nil && *cfg >= 0 {
		n = *cfg
	}
	if n < 0 {
		n = 0
	}
	if n > MaxRetryPerGate {
		n = MaxRetryPerGate
	}
	return n
}

// gateConfig returns the operator-set value for a gate, or nil if the
// app didn't override that gate. Avoids reflection — six gates is small.
func gateConfig(retry *AppRetry, gate Gate) *int {
	if retry == nil {
		return nil
	}
	switch gate {
	case GateCrash:
		return retry.Crash
	case GateVerify:
		return retry.Verify
	case GateClaim:
		return retry.Claim
	case GatePreflight:
		return retry.Preflight
	case GateStyle:
		return retry.Style
	case GateSemantic:
		return retry.Semantic
	}
	return nil
}

// CountRetryAttempts counts how many retry runs already exist for the
// (parent, baseRole, gate) tuple. All statuses count — a queued or
// running sibling reserves a budget slot, otherwise concurrent triggers
// could exceed the cap.
//
// `runs` is the meta.Runs slice; passing meta.Meta avoids importing it
// twice. parentSessionID is the *string from a Run; nil/empty = no
// parent (coordinator runs), which always returns 0.
func CountRetryAttempts(runs []meta.Run, parentSessionID *string, baseRole string, gate Gate) int {
	if parentSessionID == nil || *parentSessionID == "" {
		return 0
	}
	parent := *parentSessionID
	count := 0
	for _, r := range runs {
		if r.ParentSessionID == nil || *r.ParentSessionID != parent {
			continue
		}
		parsed := ParseRole(r.Role)
		if parsed.BaseRole != baseRole {
			continue
		}
		if parsed.Gate != gate {
			// Special case: preflight + claim share -cretry so ParseRole
			// always reports "claim" for that suffix. When the caller
			// asked about preflight, claim-tagged siblings still count
			// against the same shared retry slot (legacy behavior).
			if gate == GatePreflight && parsed.Gate == GateClaim {
				count++
			}
			continue
		}
		count++
	}
	return count
}

// EligibilityArgs is the input to CheckEligibility.
type EligibilityArgs struct {
	FinishedRun meta.Run
	Runs        []meta.Run
	Gate        Gate
	Retry       *AppRetry // may be nil when no app or no override
}

// EligibilityResult mirrors libs/retryLadder.ts. NextAttempt is only
// meaningful when Eligible is true.
type EligibilityResult struct {
	Eligible    bool
	NextAttempt int
	Reason      string // populated only when Eligible == false
}

// CheckEligibility is the generic gate-eligibility check shared by every
// retry path. Replaces the 5 nearly-identical isEligibleForXRetry
// helpers in the TS code.
//
// Rules:
//  1. Must have a parent (no coordinator-level retries).
//  2. Must be either a base run OR a same-gate retry — cross-gate
//     compounding is blocked, except claim ↔ preflight which share the
//     -cretry slot.
//  3. Existing attempts for (parent, baseRole, gate) < MaxAttemptsFor(gate).
func CheckEligibility(args EligibilityArgs) EligibilityResult {
	if args.FinishedRun.ParentSessionID == nil || *args.FinishedRun.ParentSessionID == "" {
		return EligibilityResult{Reason: "no parent session"}
	}

	parsed := ParseRole(args.FinishedRun.Role)

	// Cross-gate block: a finished retry of gate A cannot trigger gate B.
	// preflight + claim are the one tolerated cross because they share
	// a slot.
	if parsed.IsRetry() && parsed.Gate != args.Gate {
		share := (parsed.Gate == GateClaim && args.Gate == GatePreflight) ||
			(parsed.Gate == GatePreflight && args.Gate == GateClaim)
		if !share {
			return EligibilityResult{
				Reason: fmt.Sprintf("cross-gate blocked: run is already a %s retry, gate=%s cannot fire", parsed.Gate, args.Gate),
			}
		}
	}

	max := MaxAttemptsFor(args.Retry, args.Gate)
	if max == 0 {
		return EligibilityResult{Reason: fmt.Sprintf("gate=%s disabled (max=0)", args.Gate)}
	}

	fromMeta := CountRetryAttempts(args.Runs, args.FinishedRun.ParentSessionID, parsed.BaseRole, args.Gate)
	// The finishedRun is itself the Nth attempt of `gate` when its role
	// already carries this gate's suffix (or shares the cretry slot).
	// Take MAX(meta-count, parsed.attempt) so a caller passing an empty
	// runs slice (test fixture, mid-write meta) still derives the
	// correct used-count from the role string alone.
	share := (args.Gate == GatePreflight && parsed.Gate == GateClaim) ||
		(args.Gate == GateClaim && parsed.Gate == GatePreflight)
	sameGate := parsed.Gate == args.Gate || share
	used := fromMeta
	if sameGate && parsed.Attempt > used {
		used = parsed.Attempt
	}
	if used >= max {
		return EligibilityResult{Reason: fmt.Sprintf("budget exhausted: %d/%d attempts already", used, max)}
	}
	return EligibilityResult{Eligible: true, NextAttempt: used + 1}
}

// Strategy identifies the prompt-shape an individual retry attempt
// uses. The same ladder applies to every gate.
type Strategy string

const (
	StrategySameContext Strategy = "same-context" // attempt 1 — full original prompt + failure context
	StrategyFreshFocus  Strategy = "fresh-focus"  // attempt 2 — strip retry chatter, focus on the failure
	StrategyFixerOnly   Strategy = "fixer-only"   // attempt 3+ — narrowest scope, "fix this exact thing"
)

// StrategyForAttempt picks the strategy for attempt N. Same ladder for
// every gate.
func StrategyForAttempt(attempt int) Strategy {
	if attempt <= 1 {
		return StrategySameContext
	}
	if attempt == 2 {
		return StrategyFreshFocus
	}
	return StrategyFixerOnly
}

// RenderStrategyPrefix renders a header that primes the agent for the
// chosen strategy. Each retry's prompt builder prepends this BEFORE its
// gate-specific failure context block, so attempt 2+ runs open with
// explicit "this is attempt N of M, switch tactics" framing.
func RenderStrategyPrefix(gate Gate, attempt, maxAttempts int) string {
	strategy := StrategyForAttempt(attempt)
	head := fmt.Sprintf("## Retry attempt %d of %d — gate: %s — strategy: %s", attempt, maxAttempts, gate, strategy)
	switch strategy {
	case StrategySameContext:
		return strings.Join([]string{
			head,
			"",
			"Treat the failure context below as the source of truth and re-attempt the original brief.",
			"",
		}, "\n")
	case StrategyFreshFocus:
		return strings.Join([]string{
			head,
			"",
			"Earlier attempts already received the full brief and failed. **Switch tactics:** ignore stylistic concerns, focus narrowly on the failure described below. Read the relevant files, fix the underlying issue, do NOT broaden scope.",
			"",
		}, "\n")
	case StrategyFixerOnly:
		return strings.Join([]string{
			head,
			"",
			"**Final attempt.** Do not refactor, do not improve, do not explain. Make the smallest possible change that resolves the failure described below. If you cannot identify a minimal fix in 1–2 file edits, exit with verdict `NEEDS-DECISION` and surface the blocker in `## Questions for the user` — do not gamble on speculative fixes.",
			"",
		}, "\n")
	}
	// Unreachable — StrategyForAttempt only returns the three constants.
	return head
}

// DescribeRetry formats a uniform "spawned attempt N" log line.
func DescribeRetry(gate Gate, attempt, max int) string {
	g, ok := gateTable[gate]
	if !ok {
		return fmt.Sprintf("%s retry %d/%d", gate, attempt, max)
	}
	return fmt.Sprintf("%s %d/%d", g.label, attempt, max)
}

// IntPtr is a tiny convenience for tests that need to build *int
// budgets inline. Exported because callers outside this package may
// construct AppRetry literals too.
func IntPtr(n int) *int { return &n }
