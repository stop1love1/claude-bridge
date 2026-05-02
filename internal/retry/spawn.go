package retry

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// DefaultFallbackBody is the prompt body used when the cached original
// prompt is missing AND the caller didn't override FallbackBody. The
// generic phrasing matches libs/retrySpawn.ts so an operator scrubbing
// .jsonl logs sees the same line regardless of which port produced it.
const DefaultFallbackBody = "(original prompt unavailable — repo state and the failure context above are the only signals you have. Inspect the repo, infer the intent, and try to make forward progress.)"

// PrecomputedAttempt is an explicit caller-supplied attempt number. The
// inline TS shape used a `{nextAttempt: number}` object purely to make
// "did the caller pre-decide?" presence-detectable; in Go we use a nil
// pointer for the same effect, but keep the dedicated type so tests +
// callers can read the intent at the call site.
type PrecomputedAttempt struct {
	NextAttempt int
}

// SpawnRetryArgs is the per-call payload for SpawnRetry. Mirrors the TS
// SpawnRetryArgs interface field-for-field — see libs/retrySpawn.ts for
// the rationale on each.
type SpawnRetryArgs struct {
	TaskID      string
	FinishedRun meta.Run
	Gate        Gate
	// ContextBlock is sandwiched between the strategy prefix and the
	// original prompt. The caller renders the gate-specific failure
	// detail (verify steps, claim diff, preflight findings, …); this
	// package only knows the surrounding boilerplate.
	ContextBlock string
	// FallbackBody overrides DefaultFallbackBody when the original
	// prompt cache is empty. Some gates word the fallback differently
	// ("Read several relevant files first" vs "make forward progress")
	// and need that nuance to survive cache misses.
	FallbackBody string
	// LogLabel is the short tag used in stderr lines so an operator
	// scrolling logs can tell crash-retries from verify-retries at a
	// glance. Required — empty string falls back to "retry".
	LogLabel string
	// PrecomputedAttempt lets callers that already ran CheckEligibility
	// pass the result through to avoid a redundant readMeta + re-derive.
	// nil means "compute eligibility here from FinishedRun + Deps".
	PrecomputedAttempt *PrecomputedAttempt
}

// Spawner is the narrow port SpawnRetry needs from the spawn package.
// Declared as an interface (rather than taking *spawn.Spawner directly)
// so tests can inject a recording fake without standing up a real
// process registry / event bus.
type Spawner interface {
	SpawnFreeSession(cwd, prompt string, settings *spawn.ChatSettings, settingsPath, sessionID string) (*spawn.SpawnedSession, error)
}

// Deps is the bag of cross-package collaborators SpawnRetry calls into.
// Wrapping these as function-typed fields (instead of hard-importing
// internal/repos and internal/quality) keeps the dependency tree
// shallow and lets tests stub each port independently.
type Deps struct {
	// BridgeRoot is the bridge install directory; carried for parity
	// with the TS code's BRIDGE_ROOT and for callers that build the
	// settings path themselves. Currently unused by SpawnRetry — the
	// per-session settings.json write is deferred (see file note).
	BridgeRoot string
	// SessionsDir is the per-task sessions root (typically
	// `<BridgeRoot>/sessions`). SpawnRetry joins TaskID onto this to
	// reach the meta.json + retry-prompt cache.
	SessionsDir string
	// Spawner launches the new claude child. Required.
	Spawner Spawner
	// LookupApp returns the App entry for `name` (the run's repo). Nil
	// + false when the repo isn't in bridge.json — SpawnRetry treats
	// that as "no per-app retry budget; use defaults". Required.
	LookupApp func(name string) (*apps.App, bool)
	// ResolveCwd resolves a repo name to its absolute working tree
	// path. Returning ("", false) means the repo was renamed / deleted
	// since the parent run started — SpawnRetry skips with no error.
	// Required.
	ResolveCwd func(name string) (string, bool)
	// ReadOriginalPrompt returns the cached original prompt body (used
	// when the retry needs to re-issue the same brief). Empty result
	// triggers the FallbackBody / DefaultFallbackBody path. Required.
	//
	// finishedRun is passed through (rather than just the taskID) so
	// future implementations can key the cache off speculative-group
	// fields the same way the TS port does.
	ReadOriginalPrompt func(taskID string, finishedRun meta.Run) string
	// AppRetryFor extracts the per-gate budget from an App. Optional —
	// nil means "always use defaults". The internal/apps package keeps
	// retry budgets inside App.Extras as raw JSON until S?? exposes a
	// typed accessor; this hook lets the caller bridge that gap
	// without forcing internal/retry to take a JSON dependency.
	AppRetryFor func(app *apps.App) *AppRetry
}

// SpawnRetryResult is the success-shape returned by SpawnRetry. Caller
// is responsible for wiring the resulting child's lifecycle (e.g.
// runlifecycle.Wire) — keeping that step external avoids an
// import-cycle between retry and runlifecycle, which would otherwise
// need to depend on retry to fire the next gate after a finish.
type SpawnRetryResult struct {
	SessionID string
	Run       meta.Run
}

// nowISO matches the timestamp shape libs/meta.ts writes
// (`new Date().toISOString()`). Overridable in tests for determinism.
var nowISO = func() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// newSessionUUID mints a v4 session id. Duplicated rather than imported
// from internal/spawn so this package doesn't need to expose a wider
// surface from spawn just for the helper. Overridable in tests.
var newSessionUUID = func() string {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		// crypto/rand should never fail on supported platforms; fall
		// back to a deterministic time-prefixed id rather than panic
		// (mirrors internal/spawn's newUUID handling).
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // v4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}

// ErrMissingDeps is returned (purely for diagnostics; SpawnRetry never
// surfaces it as an error to callers — see the function comment) when a
// required Deps hook is nil. Exported so tests can assert against it.
var ErrMissingDeps = errors.New("retry: required Deps hook is nil")

// SpawnRetry is the shared spawn primitive every retry gate (crash,
// verify, claim, preflight, style, semantic) calls instead of inlining
// the resolve-cwd → eligibility → strategy-prefix → spawn → appendRun
// boilerplate. Mirrors libs/retrySpawn.ts spawnRetry.
//
// Returns (nil, nil) — never (nil, err) — on every recoverable skip:
//   - Deps misconfigured (caller bug, surfaces via log only)
//   - Repo can't be resolved (renamed / deleted since the parent ran)
//   - Eligibility check failed (budget exhausted, cross-gate, etc)
//   - SpawnFreeSession itself errored
//
// Callers don't need a try/catch — the only non-nil error path is a
// genuine I/O failure inside meta.AppendRun (which should be rare and
// is worth surfacing so the caller can decide whether to retry the
// retry).
//
// On success, returns a SpawnRetryResult with the new session id + the
// Run record that was appended to meta. The caller is responsible for
// wiring the child's lifecycle (typically runlifecycle.Wire) — keeping
// that out of this package avoids an import cycle: runlifecycle would
// otherwise need to depend on retry to fire the next gate.
//
// Per-session settings.json (the TS port writes one before spawn so the
// permission hook can scope to this child) is OUT of scope for this
// port — SpawnRetry passes settingsPath="" and relies on the caller to
// thread a path in via Deps once the permissionSettings package lands.
func SpawnRetry(args SpawnRetryArgs, deps Deps) (*SpawnRetryResult, error) {
	if deps.Spawner == nil || deps.LookupApp == nil || deps.ResolveCwd == nil || deps.ReadOriginalPrompt == nil {
		log.Printf("%s: %v", logLabelOr(args.LogLabel), ErrMissingDeps)
		return nil, nil
	}

	liveRepoCwd, ok := deps.ResolveCwd(args.FinishedRun.Repo)
	if !ok {
		// Repo was renamed / removed from bridge.json since the parent
		// started. Silent skip — there's nothing for the retry to edit.
		return nil, nil
	}

	// Retries inherit the parent's worktree so they edit the same
	// sandbox the original run started in. Falls back to the live tree
	// when the parent didn't use a worktree.
	spawnCwd := liveRepoCwd
	if args.FinishedRun.WorktreePath != nil && *args.FinishedRun.WorktreePath != "" {
		spawnCwd = *args.FinishedRun.WorktreePath
	}

	app, _ := deps.LookupApp(args.FinishedRun.Repo)
	var appRetry *AppRetry
	if deps.AppRetryFor != nil {
		appRetry = deps.AppRetryFor(app)
	}

	sessionsDir := filepath.Join(deps.SessionsDir, args.TaskID)

	// Re-derive eligibility at spawn time so a concurrent spawn that
	// raced us past the budget bails here rather than producing an
	// orphan Run record. The precomputed path lets callers that
	// already paid for readMeta + checkEligibility skip the redundant
	// round-trip.
	var nextAttempt int
	if args.PrecomputedAttempt != nil {
		nextAttempt = args.PrecomputedAttempt.NextAttempt
	} else {
		m, err := meta.ReadMeta(sessionsDir)
		if err != nil || m == nil {
			return nil, nil
		}
		elig := CheckEligibility(EligibilityArgs{
			FinishedRun: args.FinishedRun,
			Runs:        m.Runs,
			Gate:        args.Gate,
			Retry:       appRetry,
		})
		if !elig.Eligible {
			return nil, nil
		}
		nextAttempt = elig.NextAttempt
	}

	parsed := ParseRole(args.FinishedRun.Role)
	maxAttempts := MaxAttemptsFor(appRetry, args.Gate)
	strategyPrefix := RenderStrategyPrefix(args.Gate, nextAttempt, maxAttempts)

	originalPrompt := strings.TrimSpace(deps.ReadOriginalPrompt(args.TaskID, args.FinishedRun))
	body := originalPrompt
	if body == "" {
		body = args.FallbackBody
	}
	if body == "" {
		body = DefaultFallbackBody
	}
	// Same join shape libs/retrySpawn.ts uses: prefix\nctx\n---\n\nbody.
	// The blank line before body keeps markdown renderers from welding
	// the separator onto the body's first heading.
	retryPrompt := strings.Join([]string{strategyPrefix, args.ContextBlock, "---", "", body}, "\n")

	sessionID := newSessionUUID()

	// settingsPath="" — the per-session permission settings file the
	// TS port writes (libs/permissionSettings.ts) is out of scope for
	// this Go port. Callers needing it can layer it on top of Deps in
	// a follow-up; the spawn itself works fine without it (the child
	// inherits the bridge's default settings).
	childHandle, err := deps.Spawner.SpawnFreeSession(
		spawnCwd,
		retryPrompt,
		&spawn.ChatSettings{Mode: "bypassPermissions"},
		"",
		sessionID,
	)
	if err != nil {
		// Spawn failures are not fatal — log + skip so the caller's
		// gate-cascade can keep running. Mirrors the TS try/catch shape.
		log.Printf("%s spawn failed for %s/%s: %v", logLabelOr(args.LogLabel), args.TaskID, args.FinishedRun.SessionID, err)
		_ = childHandle // silence unused on error path
		return nil, nil
	}

	startedAt := nowISO()
	wtPath, wtBranch, wtBase := git.InheritWorktreeFields(args.FinishedRun)
	attempt := nextAttempt
	parentSession := args.FinishedRun.ParentSessionID
	retryOf := args.FinishedRun.SessionID

	retryRun := meta.Run{
		SessionID:          sessionID,
		Role:               NextRetryRole(parsed.BaseRole, args.Gate, nextAttempt),
		Repo:               args.FinishedRun.Repo,
		Status:             meta.RunStatusRunning,
		StartedAt:          &startedAt,
		EndedAt:            nil,
		ParentSessionID:    parentSession,
		RetryOf:            &retryOf,
		RetryAttempt:       &attempt,
		WorktreePath:       wtPath,
		WorktreeBranch:     wtBranch,
		WorktreeBaseBranch: wtBase,
	}
	if err := meta.AppendRun(sessionsDir, retryRun); err != nil {
		// AppendRun failures ARE surfaced — meta.json is the source of
		// truth for the dashboard, and an orphan child without a Run
		// record is exactly the inconsistency this layer must avoid.
		// The caller can decide whether to kill the just-spawned child
		// or leave it limping along.
		return nil, fmt.Errorf("retry: append run: %w", err)
	}

	return &SpawnRetryResult{SessionID: sessionID, Run: retryRun}, nil
}

// logLabelOr returns label or "retry" when label is empty. Keeps log
// lines from leading with a stray colon when a caller forgets the tag.
func logLabelOr(label string) string {
	if label == "" {
		return "retry"
	}
	return label
}
