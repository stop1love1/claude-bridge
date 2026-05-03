package meta

// Sub-types under Run. None of them are mutated by S09 itself — they
// exist so meta.json can round-trip bytewise across the Go/TS boundary
// even when an existing file carries a verifier / styleCritic / etc.
// section. The verify-chain port (post-S15 retry-ladder work) is what
// actually reads/writes these.

// RunVerify is the per-run verify-chain outcome — one row per
// configured AppVerify command (format / lint / typecheck / test / build).
type RunVerify struct {
	Steps          []RunVerifyStep `json:"steps"`
	Passed         bool            `json:"passed"`
	StartedAt      string          `json:"startedAt"`
	EndedAt        string          `json:"endedAt"`
	RetryScheduled *bool           `json:"retryScheduled,omitempty"`
}

// RunVerifyStep is one row inside RunVerify.Steps. Name is the
// canonical step name from the AppVerify shape; the bridge runs each
// in declaration order via `sh -c` / `cmd /c`.
type RunVerifyStep struct {
	Name       string `json:"name"`
	Cmd        string `json:"cmd"`
	OK         bool   `json:"ok"`
	ExitCode   *int   `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	Output     string `json:"output"`
}

// RunVerifier is the inline claim-vs-diff outcome (P2b-1).
type RunVerifier struct {
	Verdict         string   `json:"verdict"`
	Reason          string   `json:"reason"`
	ClaimedFiles    []string `json:"claimedFiles"`
	ActualFiles     []string `json:"actualFiles"`
	UnmatchedClaims []string `json:"unmatchedClaims"`
	UnclaimedActual []string `json:"unclaimedActual"`
	DurationMs      int64    `json:"durationMs"`
	RetryScheduled  *bool    `json:"retryScheduled,omitempty"`
}

// RunStyleCritic is the agent-driven style critic outcome (P2b-2).
type RunStyleCritic struct {
	Verdict         string   `json:"verdict"`
	Reason          string   `json:"reason"`
	Issues          []string `json:"issues"`
	CriticSessionID *string  `json:"criticSessionId,omitempty"`
	DurationMs      int64    `json:"durationMs"`
	RetryScheduled  *bool    `json:"retryScheduled,omitempty"`
}

// RunSemanticVerifier is the agent-driven semantic-verifier outcome.
type RunSemanticVerifier struct {
	Verdict           string   `json:"verdict"`
	Reason            string   `json:"reason"`
	Concerns          []string `json:"concerns"`
	VerifierSessionID *string  `json:"verifierSessionId,omitempty"`
	DurationMs        int64    `json:"durationMs"`
	RetryScheduled    *bool    `json:"retryScheduled,omitempty"`
}
