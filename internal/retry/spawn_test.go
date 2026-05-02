package retry_test

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/retry"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// fakeSpawner records each SpawnFreeSession call and returns either a
// canned SpawnedSession or an injected error. Concurrency-safe so the
// "spawn errored" path can be exercised alongside the happy path.
type fakeSpawner struct {
	mu sync.Mutex
	// last captured args from the most recent call.
	lastCwd          string
	lastPrompt       string
	lastSettings     *spawn.ChatSettings
	lastSettingsPath string
	lastSessionID    string
	calls            int
	// canned responses.
	err error
}

func (f *fakeSpawner) SpawnFreeSession(cwd, prompt string, settings *spawn.ChatSettings, settingsPath, sessionID string) (*spawn.SpawnedSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.lastCwd = cwd
	f.lastPrompt = prompt
	f.lastSettings = settings
	f.lastSettingsPath = settingsPath
	f.lastSessionID = sessionID
	if f.err != nil {
		return nil, f.err
	}
	done := make(chan struct{})
	close(done)
	return &spawn.SpawnedSession{SessionID: sessionID, Done: done}, nil
}

// newRetryTaskDir mints a fresh sessions root + per-task meta.json so
// SpawnRetry's readMeta path has something to land on. Returns the
// outer sessions dir (caller passes it as Deps.SessionsDir) and the
// task id used (matches meta.go's basename-as-id convention).
func newRetryTaskDir(t *testing.T, taskID string, runs []meta.Run) string {
	t.Helper()
	meta.ResetCacheForTests()
	root := t.TempDir()
	taskDir := filepath.Join(root, taskID)
	if err := meta.CreateMeta(taskDir, meta.Meta{
		TaskID:      taskID,
		TaskTitle:   "test",
		TaskBody:    "body",
		TaskStatus:  meta.TaskStatusTodo,
		TaskSection: meta.SectionTodo,
		TaskChecked: false,
		CreatedAt:   "2026-01-01T00:00:00.000Z",
	}); err != nil {
		t.Fatalf("CreateMeta: %v", err)
	}
	for _, r := range runs {
		if err := meta.AppendRun(taskDir, r); err != nil {
			t.Fatalf("AppendRun: %v", err)
		}
	}
	return root
}

// strPtr2 is a local helper so this file doesn't depend on identifier
// ordering with ladder_test.go (which also defines strPtr).
func strPtr2(s string) *string { return &s }

// baseDeps wires up a Deps with no-op resolvers and a recording
// spawner. Tests override individual fields as needed.
func baseDeps(t *testing.T, root string) (*fakeSpawner, retry.Deps) {
	t.Helper()
	fs := &fakeSpawner{}
	deps := retry.Deps{
		BridgeRoot:  t.TempDir(),
		SessionsDir: root,
		Spawner:     fs,
		LookupApp:   func(name string) (*apps.App, bool) { return nil, false },
		ResolveCwd:  func(name string) (string, bool) { return filepath.Join(root, "live", name), true },
		ReadOriginalPrompt: func(taskID string, finishedRun meta.Run) string {
			return "ORIGINAL PROMPT BODY"
		},
	}
	return fs, deps
}

func TestSpawnRetryHappyPath(t *testing.T) {
	parent := "sess_parent"
	taskID := "t_20260101_001"
	root := newRetryTaskDir(t, taskID, []meta.Run{
		{SessionID: parent, Role: "coder", Repo: "myapp", Status: meta.RunStatusDone},
	})
	fs, deps := baseDeps(t, root)

	finished := meta.Run{
		SessionID:       "sess_finished",
		Role:            "coder",
		Repo:            "myapp",
		Status:          meta.RunStatusFailed,
		ParentSessionID: &parent,
	}

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:       taskID,
		FinishedRun:  finished,
		Gate:         retry.GateVerify,
		ContextBlock: "## Verify failed\nstep `lint` exited 1",
		LogLabel:     "verify-retry",
	}, deps)
	if err != nil {
		t.Fatalf("SpawnRetry: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil result, got nil")
	}
	if res.SessionID == "" {
		t.Error("result missing SessionID")
	}
	if res.Run.SessionID != res.SessionID {
		t.Errorf("Run.SessionID %q != result.SessionID %q", res.Run.SessionID, res.SessionID)
	}
	if res.Run.Role != "coder-vretry" {
		t.Errorf("Run.Role = %q, want coder-vretry (gate=verify, attempt 1)", res.Run.Role)
	}
	if res.Run.RetryAttempt == nil || *res.Run.RetryAttempt != 1 {
		t.Errorf("RetryAttempt = %v, want 1", res.Run.RetryAttempt)
	}
	if res.Run.RetryOf == nil || *res.Run.RetryOf != finished.SessionID {
		t.Errorf("RetryOf = %v, want %q", res.Run.RetryOf, finished.SessionID)
	}
	if res.Run.ParentSessionID == nil || *res.Run.ParentSessionID != parent {
		t.Errorf("ParentSessionID = %v, want %q", res.Run.ParentSessionID, parent)
	}
	if res.Run.Status != meta.RunStatusRunning {
		t.Errorf("Status = %q, want running", res.Run.Status)
	}
	if res.Run.StartedAt == nil || *res.Run.StartedAt == "" {
		t.Error("StartedAt was not stamped")
	}

	// Spawn was called with the right shape.
	if fs.calls != 1 {
		t.Fatalf("spawner called %d times, want 1", fs.calls)
	}
	if fs.lastSessionID != res.SessionID {
		t.Errorf("spawner sessionID %q != result %q", fs.lastSessionID, res.SessionID)
	}
	if fs.lastSettings == nil || fs.lastSettings.Mode != "bypassPermissions" {
		t.Errorf("settings = %+v, want Mode=bypassPermissions", fs.lastSettings)
	}
	if fs.lastSettingsPath != "" {
		t.Errorf("settingsPath = %q, want empty (per-session settings deferred)", fs.lastSettingsPath)
	}
	if !strings.Contains(fs.lastPrompt, "Retry attempt 1") {
		t.Errorf("prompt missing strategy header: %q", fs.lastPrompt)
	}
	if !strings.Contains(fs.lastPrompt, "## Verify failed") {
		t.Errorf("prompt missing context block: %q", fs.lastPrompt)
	}
	if !strings.Contains(fs.lastPrompt, "ORIGINAL PROMPT BODY") {
		t.Errorf("prompt missing original body: %q", fs.lastPrompt)
	}
	if !strings.Contains(fs.lastPrompt, "---") {
		t.Errorf("prompt missing separator: %q", fs.lastPrompt)
	}

	// AppendRun landed on disk.
	m, err := meta.ReadMeta(filepath.Join(root, taskID))
	if err != nil || m == nil {
		t.Fatalf("ReadMeta after spawn: %v / %v", m, err)
	}
	if len(m.Runs) != 2 {
		t.Errorf("runs after spawn = %d, want 2 (parent + retry)", len(m.Runs))
	}
}

func TestSpawnRetryWorktreeInheritance(t *testing.T) {
	// FinishedRun ran in a worktree → spawn cwd must be the worktree
	// path, not the live tree, AND the new Run must inherit the three
	// worktree fields so a follow-up retry stays on the same sandbox.
	parent := "sess_parent"
	taskID := "t_20260101_002"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)

	finished := meta.Run{
		SessionID:          "sess_finished",
		Role:               "coder",
		Repo:               "myapp",
		Status:             meta.RunStatusFailed,
		ParentSessionID:    &parent,
		WorktreePath:       strPtr2("/wt/path"),
		WorktreeBranch:     strPtr2("claude/wt/abc"),
		WorktreeBaseBranch: strPtr2("main"),
	}

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:      taskID,
		FinishedRun: finished,
		Gate:        retry.GateCrash,
		LogLabel:    "crash-retry",
	}, deps)
	if err != nil || res == nil {
		t.Fatalf("SpawnRetry: res=%v err=%v", res, err)
	}
	if fs.lastCwd != "/wt/path" {
		t.Errorf("spawn cwd = %q, want /wt/path (worktree)", fs.lastCwd)
	}
	if res.Run.WorktreePath == nil || *res.Run.WorktreePath != "/wt/path" {
		t.Errorf("retry WorktreePath = %v, want /wt/path", res.Run.WorktreePath)
	}
	if res.Run.WorktreeBranch == nil || *res.Run.WorktreeBranch != "claude/wt/abc" {
		t.Errorf("retry WorktreeBranch = %v, want claude/wt/abc", res.Run.WorktreeBranch)
	}
	if res.Run.WorktreeBaseBranch == nil || *res.Run.WorktreeBaseBranch != "main" {
		t.Errorf("retry WorktreeBaseBranch = %v, want main", res.Run.WorktreeBaseBranch)
	}
}

func TestSpawnRetryRepoUnresolvedReturnsNil(t *testing.T) {
	taskID := "t_20260101_003"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)
	deps.ResolveCwd = func(name string) (string, bool) { return "", false }

	parent := "p"
	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:      taskID,
		FinishedRun: meta.Run{SessionID: "x", Role: "coder", Repo: "ghost", ParentSessionID: &parent},
		Gate:        retry.GateVerify,
		LogLabel:    "verify-retry",
	}, deps)
	if res != nil || err != nil {
		t.Errorf("renamed repo should produce (nil, nil), got res=%v err=%v", res, err)
	}
	if fs.calls != 0 {
		t.Errorf("spawner called %d times, want 0 (skip before spawn)", fs.calls)
	}
}

func TestSpawnRetryEligibilityFailReturnsNil(t *testing.T) {
	// FinishedRun has no parent → CheckEligibility bails. Confirms
	// SpawnRetry threads that into a graceful skip rather than an error.
	taskID := "t_20260101_004"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:      taskID,
		FinishedRun: meta.Run{SessionID: "x", Role: "coder", Repo: "myapp"}, // no ParentSessionID
		Gate:        retry.GateVerify,
		LogLabel:    "verify-retry",
	}, deps)
	if res != nil || err != nil {
		t.Errorf("ineligible run should produce (nil, nil), got res=%v err=%v", res, err)
	}
	if fs.calls != 0 {
		t.Errorf("spawner called %d times, want 0", fs.calls)
	}
}

func TestSpawnRetrySpawnerErrorReturnsNil(t *testing.T) {
	// Spawner.SpawnFreeSession failures must NOT propagate as errors —
	// the caller's gate cascade keeps running. Mirrors the TS try/catch.
	parent := "p"
	taskID := "t_20260101_005"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)
	fs.err = errors.New("synthetic spawn failure")

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:      taskID,
		FinishedRun: meta.Run{SessionID: "x", Role: "coder", Repo: "myapp", ParentSessionID: &parent},
		Gate:        retry.GateClaim,
		LogLabel:    "claim-retry",
	}, deps)
	if res != nil || err != nil {
		t.Errorf("spawner error should produce (nil, nil), got res=%v err=%v", res, err)
	}
	// AppendRun must NOT have run — orphan record is exactly what we're
	// guarding against.
	m, _ := meta.ReadMeta(filepath.Join(root, taskID))
	if m != nil && len(m.Runs) != 0 {
		t.Errorf("runs after failed spawn = %d, want 0 (no orphan)", len(m.Runs))
	}
}

func TestSpawnRetryFallbackBody(t *testing.T) {
	// ReadOriginalPrompt returns "" and the caller supplied a custom
	// FallbackBody — that text must show up in the prompt instead of the
	// generic DefaultFallbackBody.
	parent := "p"
	taskID := "t_20260101_006"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)
	deps.ReadOriginalPrompt = func(taskID string, finishedRun meta.Run) string { return "   " } // whitespace → trimmed empty

	const customBody = "Read several relevant files first, then make the smallest possible change."
	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:       taskID,
		FinishedRun:  meta.Run{SessionID: "x", Role: "coder", Repo: "myapp", ParentSessionID: &parent},
		Gate:         retry.GateStyle,
		ContextBlock: "## Style critic rejected",
		FallbackBody: customBody,
		LogLabel:     "style-retry",
	}, deps)
	if err != nil || res == nil {
		t.Fatalf("SpawnRetry: res=%v err=%v", res, err)
	}
	if !strings.Contains(fs.lastPrompt, customBody) {
		t.Errorf("prompt missing FallbackBody override: %q", fs.lastPrompt)
	}
	if strings.Contains(fs.lastPrompt, retry.DefaultFallbackBody) {
		t.Errorf("prompt should NOT contain DefaultFallbackBody when FallbackBody is set: %q", fs.lastPrompt)
	}
}

func TestSpawnRetryDefaultFallbackBody(t *testing.T) {
	// No original prompt + no caller override → DefaultFallbackBody
	// kicks in. Defensive check that the empty-everywhere path doesn't
	// produce a blank body section.
	parent := "p"
	taskID := "t_20260101_007"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)
	deps.ReadOriginalPrompt = func(taskID string, finishedRun meta.Run) string { return "" }

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:      taskID,
		FinishedRun: meta.Run{SessionID: "x", Role: "coder", Repo: "myapp", ParentSessionID: &parent},
		Gate:        retry.GatePreflight,
		LogLabel:    "preflight-retry",
	}, deps)
	if err != nil || res == nil {
		t.Fatalf("SpawnRetry: res=%v err=%v", res, err)
	}
	if !strings.Contains(fs.lastPrompt, retry.DefaultFallbackBody) {
		t.Errorf("prompt missing DefaultFallbackBody: %q", fs.lastPrompt)
	}
}

func TestSpawnRetryPrecomputedAttempt(t *testing.T) {
	// When the caller supplies PrecomputedAttempt, SpawnRetry must NOT
	// re-derive eligibility — it trusts the number and uses it for the
	// strategy prefix + role suffix. Verified by running with a
	// FinishedRun that would otherwise be ineligible (no parent).
	taskID := "t_20260101_008"
	root := newRetryTaskDir(t, taskID, nil)
	fs, deps := baseDeps(t, root)

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID:             taskID,
		FinishedRun:        meta.Run{SessionID: "x", Role: "coder", Repo: "myapp"}, // no parent — would fail eligibility
		Gate:               retry.GateVerify,
		LogLabel:           "verify-retry",
		PrecomputedAttempt: &retry.PrecomputedAttempt{NextAttempt: 3},
	}, deps)
	if err != nil || res == nil {
		t.Fatalf("SpawnRetry with precomputed should succeed despite missing parent: res=%v err=%v", res, err)
	}
	if res.Run.RetryAttempt == nil || *res.Run.RetryAttempt != 3 {
		t.Errorf("RetryAttempt = %v, want 3 (from precomputed)", res.Run.RetryAttempt)
	}
	if res.Run.Role != "coder-vretry3" {
		t.Errorf("Role = %q, want coder-vretry3", res.Run.Role)
	}
	if !strings.Contains(fs.lastPrompt, "Retry attempt 3") {
		t.Errorf("prompt strategy prefix missing 'Retry attempt 3': %q", fs.lastPrompt)
	}
}

func TestSpawnRetryAppRetryBudgetThreaded(t *testing.T) {
	// When AppRetryFor is set, the per-app budget overrides the default
	// (1) — verifies the Deps.AppRetryFor hook actually reaches
	// CheckEligibility / MaxAttemptsFor. Without it, attempt 2 would be
	// rejected by the default budget.
	parent := "p"
	taskID := "t_20260101_009"
	root := newRetryTaskDir(t, taskID, []meta.Run{
		{SessionID: "a", Role: "coder-vretry", Repo: "myapp", ParentSessionID: &parent},
	})
	_, deps := baseDeps(t, root)
	deps.AppRetryFor = func(app *apps.App) *retry.AppRetry {
		return &retry.AppRetry{Verify: retry.IntPtr(3)}
	}

	res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
		TaskID: taskID,
		FinishedRun: meta.Run{
			SessionID: "x", Role: "coder-vretry", Repo: "myapp", ParentSessionID: &parent,
		},
		Gate:     retry.GateVerify,
		LogLabel: "verify-retry",
	}, deps)
	if err != nil || res == nil {
		t.Fatalf("SpawnRetry with budget=3 + 1 used should succeed: res=%v err=%v", res, err)
	}
	if res.Run.RetryAttempt == nil || *res.Run.RetryAttempt != 2 {
		t.Errorf("RetryAttempt = %v, want 2", res.Run.RetryAttempt)
	}
	if res.Run.Role != "coder-vretry2" {
		t.Errorf("Role = %q, want coder-vretry2", res.Run.Role)
	}
}

func TestSpawnRetryMissingDepsReturnsNil(t *testing.T) {
	// Required Deps hook missing → graceful skip, no panic. Caller bug
	// surfaces via log only (we don't fail the gate cascade for it).
	cases := map[string]retry.Deps{
		"nil spawner": {
			LookupApp:          func(string) (*apps.App, bool) { return nil, false },
			ResolveCwd:         func(string) (string, bool) { return "/x", true },
			ReadOriginalPrompt: func(string, meta.Run) string { return "" },
		},
		"nil lookup": {
			Spawner:            &fakeSpawner{},
			ResolveCwd:         func(string) (string, bool) { return "/x", true },
			ReadOriginalPrompt: func(string, meta.Run) string { return "" },
		},
		"nil resolve": {
			Spawner:            &fakeSpawner{},
			LookupApp:          func(string) (*apps.App, bool) { return nil, false },
			ReadOriginalPrompt: func(string, meta.Run) string { return "" },
		},
		"nil readPrompt": {
			Spawner:    &fakeSpawner{},
			LookupApp:  func(string) (*apps.App, bool) { return nil, false },
			ResolveCwd: func(string) (string, bool) { return "/x", true },
		},
	}
	for name, deps := range cases {
		t.Run(name, func(t *testing.T) {
			res, err := retry.SpawnRetry(retry.SpawnRetryArgs{
				TaskID:      "t_20260101_010",
				FinishedRun: meta.Run{SessionID: "x", Role: "coder", Repo: "myapp"},
				Gate:        retry.GateVerify,
				LogLabel:    "verify-retry",
			}, deps)
			if res != nil || err != nil {
				t.Errorf("missing dep should produce (nil, nil), got res=%v err=%v", res, err)
			}
		})
	}
}
