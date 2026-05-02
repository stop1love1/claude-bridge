package retry_test

import (
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/retry"
)

func strPtr(s string) *string { return &s }

func TestParseRole(t *testing.T) {
	cases := []struct {
		role     string
		baseRole string
		gate     retry.Gate
		attempt  int
	}{
		// Base roles with no suffix.
		{"coder", "coder", "", 0},
		{"reviewer", "reviewer", "", 0},
		// Base role that happens to end in a digit — must NOT be read as
		// a retry counter.
		{"coder-v2", "coder-v2", "", 0},

		// Attempt-1 retries (no trailing digit).
		{"coder-retry", "coder", retry.GateCrash, 1},
		{"coder-vretry", "coder", retry.GateVerify, 1},
		{"coder-cretry", "coder", retry.GateClaim, 1},
		{"coder-stretry", "coder", retry.GateStyle, 1},
		{"coder-svretry", "coder", retry.GateSemantic, 1},

		// Attempt ≥ 2 retries.
		{"coder-vretry2", "coder", retry.GateVerify, 2},
		{"coder-vretry3", "coder", retry.GateVerify, 3},
		{"coder-stretry2", "coder", retry.GateStyle, 2},
		{"coder-svretry5", "coder", retry.GateSemantic, 5},
		{"coder-cretry4", "coder", retry.GateClaim, 4},
		{"coder-retry2", "coder", retry.GateCrash, 2},

		// Defensive: explicit `1` digit is accepted (round-trips through
		// the same code path future normalizers might use).
		{"coder-vretry1", "coder", retry.GateVerify, 1},

		// Suffix ordering: -svretry must beat -vretry, -stretry must
		// beat -retry. Without that ordering these would mis-parse.
		{"x-svretry", "x", retry.GateSemantic, 1},
		{"x-stretry", "x", retry.GateStyle, 1},
	}
	for _, c := range cases {
		got := retry.ParseRole(c.role)
		if got.BaseRole != c.baseRole || got.Gate != c.gate || got.Attempt != c.attempt {
			t.Errorf("ParseRole(%q) = {%q, %q, %d}, want {%q, %q, %d}",
				c.role, got.BaseRole, got.Gate, got.Attempt, c.baseRole, c.gate, c.attempt)
		}
	}
}

func TestParseRoleRoundtripWithNextRetryRole(t *testing.T) {
	// Every (base, gate, attempt) the suffix scheme can express must
	// survive NextRetryRole → ParseRole → equal.
	gates := []retry.Gate{
		retry.GateCrash, retry.GateVerify, retry.GateClaim,
		retry.GatePreflight, retry.GateStyle, retry.GateSemantic,
	}
	for _, g := range gates {
		for attempt := 1; attempt <= 5; attempt++ {
			role := retry.NextRetryRole("coder", g, attempt)
			parsed := retry.ParseRole(role)
			// preflight + claim share -cretry, so parsing always reports
			// "claim" — exempt that one case from strict equality.
			expectGate := g
			if g == retry.GatePreflight {
				expectGate = retry.GateClaim
			}
			if parsed.BaseRole != "coder" || parsed.Gate != expectGate || parsed.Attempt != attempt {
				t.Errorf("roundtrip gate=%s attempt=%d: built %q, parsed {%q, %q, %d}",
					g, attempt, role, parsed.BaseRole, parsed.Gate, parsed.Attempt)
			}
		}
	}
}

func TestIsAnyRetryRole(t *testing.T) {
	for _, role := range []string{"coder", "reviewer", "coder-v2"} {
		if retry.IsAnyRetryRole(role) {
			t.Errorf("IsAnyRetryRole(%q) = true, want false", role)
		}
	}
	for _, role := range []string{"coder-retry", "coder-vretry", "coder-stretry2", "x-svretry"} {
		if !retry.IsAnyRetryRole(role) {
			t.Errorf("IsAnyRetryRole(%q) = false, want true", role)
		}
	}
}

func TestNextRetryRole(t *testing.T) {
	cases := []struct {
		base    string
		gate    retry.Gate
		attempt int
		want    string
	}{
		{"coder", retry.GateCrash, 1, "coder-retry"},
		{"coder", retry.GateVerify, 1, "coder-vretry"},
		{"coder", retry.GateVerify, 2, "coder-vretry2"},
		{"coder", retry.GateClaim, 3, "coder-cretry3"},
		{"coder", retry.GatePreflight, 1, "coder-cretry"}, // shares slot with claim
		{"coder", retry.GatePreflight, 2, "coder-cretry2"},
		{"coder", retry.GateStyle, 4, "coder-stretry4"},
		{"coder", retry.GateSemantic, 5, "coder-svretry5"},
		// nextAttempt ≤ 0 still falls through to the un-numbered shape.
		{"coder", retry.GateVerify, 0, "coder-vretry"},
	}
	for _, c := range cases {
		got := retry.NextRetryRole(c.base, c.gate, c.attempt)
		if got != c.want {
			t.Errorf("NextRetryRole(%q, %s, %d) = %q, want %q", c.base, c.gate, c.attempt, got, c.want)
		}
	}
}

func TestMaxAttemptsFor(t *testing.T) {
	// nil cfg → fallback (1).
	if got := retry.MaxAttemptsFor(nil, retry.GateVerify); got != 1 {
		t.Errorf("MaxAttemptsFor(nil, verify) = %d, want 1", got)
	}
	// Per-gate override wins.
	cfg := &retry.AppRetry{Verify: retry.IntPtr(3)}
	if got := retry.MaxAttemptsFor(cfg, retry.GateVerify); got != 3 {
		t.Errorf("MaxAttemptsFor(verify=3) = %d, want 3", got)
	}
	// Other gates fall back to default.
	if got := retry.MaxAttemptsFor(cfg, retry.GateClaim); got != 1 {
		t.Errorf("MaxAttemptsFor(claim, verify-only-cfg) = %d, want 1 (fallback)", got)
	}
	// 0 disables the gate.
	cfg = &retry.AppRetry{Crash: retry.IntPtr(0)}
	if got := retry.MaxAttemptsFor(cfg, retry.GateCrash); got != 0 {
		t.Errorf("MaxAttemptsFor(crash=0) = %d, want 0", got)
	}
	// Negative falls back to default (matches TS: the `cfg >= 0` guard
	// rejects negatives and substitutes the per-gate fallback).
	cfg = &retry.AppRetry{Style: retry.IntPtr(-3)}
	if got := retry.MaxAttemptsFor(cfg, retry.GateStyle); got != 1 {
		t.Errorf("MaxAttemptsFor(style=-3) = %d, want 1 (fallback after negative-reject)", got)
	}
	// Above MaxRetryPerGate clamps down.
	cfg = &retry.AppRetry{Semantic: retry.IntPtr(99)}
	if got := retry.MaxAttemptsFor(cfg, retry.GateSemantic); got != retry.MaxRetryPerGate {
		t.Errorf("MaxAttemptsFor(semantic=99) = %d, want %d", got, retry.MaxRetryPerGate)
	}
}

func TestCountRetryAttempts(t *testing.T) {
	parent := "sess_parent"
	other := "sess_other"
	runs := []meta.Run{
		// Same parent + base + gate=verify, three attempts.
		{SessionID: "a", Role: "coder-vretry", ParentSessionID: &parent},
		{SessionID: "b", Role: "coder-vretry2", ParentSessionID: &parent},
		{SessionID: "c", Role: "coder-vretry3", ParentSessionID: &parent},
		// Different gate — should not count toward verify.
		{SessionID: "d", Role: "coder-stretry", ParentSessionID: &parent},
		// Different base — should not count.
		{SessionID: "e", Role: "reviewer-vretry", ParentSessionID: &parent},
		// Different parent — should not count.
		{SessionID: "f", Role: "coder-vretry", ParentSessionID: &other},
		// No parent at all — should not count.
		{SessionID: "g", Role: "coder-vretry"},
	}
	if got := retry.CountRetryAttempts(runs, &parent, "coder", retry.GateVerify); got != 3 {
		t.Errorf("count verify = %d, want 3", got)
	}
	if got := retry.CountRetryAttempts(runs, &parent, "coder", retry.GateStyle); got != 1 {
		t.Errorf("count style = %d, want 1", got)
	}
	if got := retry.CountRetryAttempts(runs, &parent, "coder", retry.GateCrash); got != 0 {
		t.Errorf("count crash = %d, want 0", got)
	}
	// nil parent → 0.
	if got := retry.CountRetryAttempts(runs, nil, "coder", retry.GateVerify); got != 0 {
		t.Errorf("count nil-parent = %d, want 0", got)
	}
	// Empty parent string → 0 (defensive).
	empty := ""
	if got := retry.CountRetryAttempts(runs, &empty, "coder", retry.GateVerify); got != 0 {
		t.Errorf("count empty-parent = %d, want 0", got)
	}
}

func TestCountRetryAttemptsClaimPreflightShareSlot(t *testing.T) {
	// claim + preflight share the -cretry suffix; ParseRole always
	// reports "claim". When the caller asks about preflight, claim-tagged
	// siblings still consume the shared slot — but the inverse (asking
	// about claim, finding preflight) doesn't apply because preflight
	// can never appear as a parsed gate.
	parent := "p"
	runs := []meta.Run{
		{SessionID: "a", Role: "coder-cretry", ParentSessionID: &parent},  // parses as claim
		{SessionID: "b", Role: "coder-cretry2", ParentSessionID: &parent}, // parses as claim
	}
	if got := retry.CountRetryAttempts(runs, &parent, "coder", retry.GateClaim); got != 2 {
		t.Errorf("count claim = %d, want 2", got)
	}
	if got := retry.CountRetryAttempts(runs, &parent, "coder", retry.GatePreflight); got != 2 {
		t.Errorf("count preflight (shares slot) = %d, want 2", got)
	}
}

func TestCheckEligibilityNoParent(t *testing.T) {
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder"},
		Gate:        retry.GateVerify,
	})
	if res.Eligible {
		t.Errorf("expected ineligible without parent, got %+v", res)
	}
	if !strings.Contains(res.Reason, "no parent") {
		t.Errorf("reason = %q, want contains 'no parent'", res.Reason)
	}
}

func TestCheckEligibilityCrossGateBlocked(t *testing.T) {
	parent := "p"
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder-vretry", ParentSessionID: &parent},
		Gate:        retry.GateStyle,
	})
	if res.Eligible {
		t.Errorf("verify-retry → style retry must be blocked, got %+v", res)
	}
	if !strings.Contains(res.Reason, "cross-gate") {
		t.Errorf("reason = %q, want contains 'cross-gate'", res.Reason)
	}
}

func TestCheckEligibilityClaimPreflightShareCrossGate(t *testing.T) {
	// Cross-gate is allowed in BOTH directions for claim ↔ preflight.
	parent := "p"
	cfg := &retry.AppRetry{Claim: retry.IntPtr(2), Preflight: retry.IntPtr(2)}

	// claim retry asking about preflight — allowed (and finishedRun
	// counts as one used slot).
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder-cretry", ParentSessionID: &parent},
		Gate:        retry.GatePreflight,
		Retry:       cfg,
	})
	if !res.Eligible {
		t.Errorf("claim → preflight should be allowed (shared slot), got %+v", res)
	}
	if res.NextAttempt != 2 {
		t.Errorf("nextAttempt = %d, want 2 (cretry was attempt 1)", res.NextAttempt)
	}
}

func TestCheckEligibilityBudgetExhausted(t *testing.T) {
	parent := "p"
	cfg := &retry.AppRetry{Verify: retry.IntPtr(2)}
	runs := []meta.Run{
		{SessionID: "a", Role: "coder-vretry", ParentSessionID: &parent},
		{SessionID: "b", Role: "coder-vretry2", ParentSessionID: &parent},
	}
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder-vretry2", ParentSessionID: &parent},
		Runs:        runs,
		Gate:        retry.GateVerify,
		Retry:       cfg,
	})
	if res.Eligible {
		t.Errorf("budget=2 with 2 used must be ineligible, got %+v", res)
	}
	if !strings.Contains(res.Reason, "budget exhausted") {
		t.Errorf("reason = %q, want contains 'budget exhausted'", res.Reason)
	}
}

func TestCheckEligibilityGateDisabled(t *testing.T) {
	parent := "p"
	cfg := &retry.AppRetry{Crash: retry.IntPtr(0)}
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder", ParentSessionID: &parent},
		Gate:        retry.GateCrash,
		Retry:       cfg,
	})
	if res.Eligible {
		t.Errorf("gate disabled (max=0) must be ineligible, got %+v", res)
	}
	if !strings.Contains(res.Reason, "disabled") {
		t.Errorf("reason = %q, want contains 'disabled'", res.Reason)
	}
}

func TestCheckEligibilityHappyPathBaseRun(t *testing.T) {
	parent := "p"
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder", ParentSessionID: &parent},
		Gate:        retry.GateVerify,
	})
	if !res.Eligible {
		t.Errorf("base run + default budget must be eligible, got %+v", res)
	}
	if res.NextAttempt != 1 {
		t.Errorf("first retry → NextAttempt = %d, want 1", res.NextAttempt)
	}
}

func TestCheckEligibilityHappyPathSameGateChain(t *testing.T) {
	parent := "p"
	cfg := &retry.AppRetry{Verify: retry.IntPtr(3)}
	// Pretend attempt 1 already ran; now asking whether attempt 2 fires.
	runs := []meta.Run{
		{SessionID: "a", Role: "coder-vretry", ParentSessionID: &parent},
	}
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder-vretry", ParentSessionID: &parent},
		Runs:        runs,
		Gate:        retry.GateVerify,
		Retry:       cfg,
	})
	if !res.Eligible {
		t.Errorf("same-gate retry within budget must be eligible, got %+v", res)
	}
	if res.NextAttempt != 2 {
		t.Errorf("NextAttempt = %d, want 2", res.NextAttempt)
	}
}

func TestCheckEligibilityFromRoleAloneWhenMetaEmpty(t *testing.T) {
	// Mid-write meta or test fixture: runs slice is empty, but the
	// finishedRun.Role itself encodes attempt N. Used-count must derive
	// from the role string so the ladder doesn't oversubscribe.
	parent := "p"
	cfg := &retry.AppRetry{Verify: retry.IntPtr(3)}
	res := retry.CheckEligibility(retry.EligibilityArgs{
		FinishedRun: meta.Run{Role: "coder-vretry3", ParentSessionID: &parent},
		Runs:        nil, // empty meta!
		Gate:        retry.GateVerify,
		Retry:       cfg,
	})
	if res.Eligible {
		t.Errorf("attempt 3 with budget 3 must be ineligible from role alone, got %+v", res)
	}
}

func TestStrategyForAttempt(t *testing.T) {
	cases := []struct {
		attempt int
		want    retry.Strategy
	}{
		{0, retry.StrategySameContext}, // attempt ≤ 1 is same-context
		{1, retry.StrategySameContext},
		{2, retry.StrategyFreshFocus},
		{3, retry.StrategyFixerOnly},
		{4, retry.StrategyFixerOnly},
		{5, retry.StrategyFixerOnly},
	}
	for _, c := range cases {
		if got := retry.StrategyForAttempt(c.attempt); got != c.want {
			t.Errorf("StrategyForAttempt(%d) = %q, want %q", c.attempt, got, c.want)
		}
	}
}

func TestRenderStrategyPrefix(t *testing.T) {
	// Smoke-test the three branches: header is present, distinguishing
	// phrases land. The exact prose is exercised by the TS test suite;
	// here we just guard against accidental empty / wrong-strategy output.
	got := retry.RenderStrategyPrefix(retry.GateVerify, 1, 3)
	if !strings.Contains(got, "Retry attempt 1 of 3") || !strings.Contains(got, "verify") {
		t.Errorf("attempt 1 prefix missing header: %q", got)
	}
	if !strings.Contains(got, "source of truth") {
		t.Errorf("attempt 1 prefix missing same-context body: %q", got)
	}

	got = retry.RenderStrategyPrefix(retry.GateStyle, 2, 3)
	if !strings.Contains(got, "Switch tactics") {
		t.Errorf("attempt 2 prefix missing fresh-focus body: %q", got)
	}

	got = retry.RenderStrategyPrefix(retry.GateClaim, 3, 3)
	if !strings.Contains(got, "Final attempt") || !strings.Contains(got, "NEEDS-DECISION") {
		t.Errorf("attempt 3 prefix missing fixer-only body: %q", got)
	}
}

func TestDescribeRetry(t *testing.T) {
	if got := retry.DescribeRetry(retry.GateVerify, 2, 3); got != "verify retry 2/3" {
		t.Errorf("DescribeRetry verify = %q, want 'verify retry 2/3'", got)
	}
	if got := retry.DescribeRetry(retry.GatePreflight, 1, 1); got != "preflight retry 1/1" {
		t.Errorf("DescribeRetry preflight = %q, want 'preflight retry 1/1'", got)
	}
}
