package runlifecycle_test

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/runlifecycle"
)

// requireShell skips when the platform's shell isn't reachable on PATH.
// On Windows under git-bash the unix-style PATH can hide cmd.exe from
// Go's exec.LookPath; on POSIX sh is virtually always present but we
// guard for parity.
func requireShell(t *testing.T) {
	t.Helper()
	bin := "sh"
	if runtime.GOOS == "windows" {
		bin = "cmd"
	}
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("shell %q not reachable on PATH: %v", bin, err)
	}
}

// shellOverride picks an invocation that works on the current OS.
// Tests run on both Windows (CI + local dev) and POSIX (Linux CI), and
// the verify runner exposes ShellOverride exactly so callers can
// pin the shell deterministically. We pin it here so each test
// asserts on a known shell, not whatever runtime.GOOS happens to pick.
//
// Side effect: callers that use shellOverride() will skip via
// requireShell(t) when the underlying shell binary cannot be located —
// some local dev environments (git-bash with a unix-style PATH) hide
// cmd.exe from Go's exec.LookPath, and CI runs the same suite under
// real shells.
func shellOverride() string {
	if runtime.GOOS == "windows" {
		return "cmd /c"
	}
	return "sh -c"
}

// successCmd / failCmd return shell strings that reliably exit 0/1
// across platforms. Avoids depending on `git --version` etc. — pure
// shell built-ins keep the tests fast and dependency-free.
func successCmd() string {
	if runtime.GOOS == "windows" {
		return "exit 0"
	}
	return "exit 0"
}

func failCmd() string {
	if runtime.GOOS == "windows" {
		return "exit 1"
	}
	return "exit 1"
}

// echoCmd returns a shell command that prints `text` to stdout. Used to
// exercise the output-capture + truncation paths.
func echoCmd(text string) string {
	// echo works on both cmd and sh, but cmd echoes trailing whitespace
	// differently. Tests that care about exact bytes use `printf` on
	// POSIX and stick to short literals on cmd.
	return "echo " + text
}

func TestRunHappyPathAllZero(t *testing.T) {
	requireShell(t)
	// All steps pass → Passed=true, Steps recorded in canonical order,
	// every ExitCode=0, OK=true, StartedAt/EndedAt populated.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: successCmd()},
		{Name: "lint", Cmd: successCmd()},
		{Name: "typecheck", Cmd: successCmd()},
	}
	out, err := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	if err != nil {
		t.Fatalf("Run: unexpected error: %v", err)
	}
	if !out.Passed {
		t.Errorf("Passed: got false, want true; steps=%+v", out.Steps)
	}
	if len(out.Steps) != 3 {
		t.Fatalf("Steps: got %d rows, want 3", len(out.Steps))
	}
	wantOrder := []string{"format", "lint", "typecheck"}
	for i, s := range out.Steps {
		if s.Name != wantOrder[i] {
			t.Errorf("Steps[%d].Name: got %q, want %q", i, s.Name, wantOrder[i])
		}
		if !s.OK {
			t.Errorf("Steps[%d].OK: got false, want true", i)
		}
		if s.ExitCode == nil || *s.ExitCode != 0 {
			t.Errorf("Steps[%d].ExitCode: got %v, want 0", i, s.ExitCode)
		}
	}
	if out.StartedAt == "" || out.EndedAt == "" {
		t.Errorf("StartedAt/EndedAt: got %q / %q, want non-empty", out.StartedAt, out.EndedAt)
	}
}

func TestRunStopsOnFirstFailure(t *testing.T) {
	requireShell(t)
	// Fail at lint → format runs, lint fails, typecheck/test/build are
	// not attempted. Steps slice has exactly 2 rows.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: successCmd()},
		{Name: "lint", Cmd: failCmd()},
		{Name: "typecheck", Cmd: successCmd()},
		{Name: "test", Cmd: successCmd()},
	}
	out, err := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	if err != nil {
		t.Fatalf("Run: unexpected error: %v", err)
	}
	if out.Passed {
		t.Errorf("Passed: got true, want false")
	}
	if len(out.Steps) != 2 {
		t.Fatalf("Steps: got %d rows, want 2 (chain should stop after lint)", len(out.Steps))
	}
	if !out.Steps[0].OK {
		t.Errorf("Steps[0] (format): want OK=true")
	}
	if out.Steps[1].OK {
		t.Errorf("Steps[1] (lint): want OK=false")
	}
	if out.Steps[1].ExitCode == nil || *out.Steps[1].ExitCode == 0 {
		t.Errorf("Steps[1].ExitCode: got %v, want non-zero", out.Steps[1].ExitCode)
	}
}

func TestRunCapturesExitCode(t *testing.T) {
	requireShell(t)
	// Each row's ExitCode pointer must be set to the actual numeric
	// value the shell returned, not just "non-nil on success / nil on
	// fail" — downstream consumers (the retry-context block render in
	// the TS port) display it verbatim.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: successCmd()},
		{Name: "lint", Cmd: failCmd()},
	}
	out, _ := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	if out.Steps[0].ExitCode == nil || *out.Steps[0].ExitCode != 0 {
		t.Errorf("format.ExitCode: got %v, want pointer to 0", out.Steps[0].ExitCode)
	}
	if out.Steps[1].ExitCode == nil {
		t.Errorf("lint.ExitCode: got nil, want pointer to non-zero exit")
	} else if *out.Steps[1].ExitCode == 0 {
		t.Errorf("lint.ExitCode: got pointer to 0, want non-zero")
	}
}

func TestRunCapsOutputAtCapBytes(t *testing.T) {
	requireShell(t)
	// Default cap is 16KB; stuffing >16KB worth of output via repeated
	// echoes triggers the truncation marker. We use a small custom cap
	// (128 bytes) to keep the test fast and the assertion bounds tight.
	bigText := strings.Repeat("x", 4096)
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: echoCmd(bigText)},
	}
	out, _ := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride:  shellOverride(),
		OutputCapBytes: 128,
	})
	if len(out.Steps) != 1 {
		t.Fatalf("Steps: got %d, want 1", len(out.Steps))
	}
	row := out.Steps[0]
	// Captured bytes (before the truncation marker) should be ≤ cap.
	// Marker text adds bytes beyond cap — we measure the prefix.
	const marker = "(bridge: output truncated"
	idx := strings.Index(row.Output, marker)
	if idx < 0 {
		t.Fatalf("Output: missing truncation marker; output=%q", row.Output)
	}
	prefix := row.Output[:idx]
	if len(prefix) > 128+8 { // +8 slack for the trailing "\n\n…"
		t.Errorf("Output prefix length: got %d, want ≤ ~128", len(prefix))
	}
	if !row.OK {
		// echo of a long line should still succeed — truncation is a
		// capture-side concern, not an exit-code concern.
		t.Errorf("OK: got false on a chatty-but-zero-exit step; ExitCode=%v output=%q", row.ExitCode, row.Output)
	}
}

func TestRunDefaultsApplyWhenZero(t *testing.T) {
	requireShell(t)
	// Passing VerifyOptions{} (all zero) should not crash — Run picks
	// DefaultVerifyOutputCapBytes / DefaultVerifyStepTimeout and the
	// platform-default shell. Tiny success command verifies the path.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: successCmd()},
	}
	out, err := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{})
	if err != nil {
		t.Fatalf("Run with zero opts: %v", err)
	}
	if !out.Passed || len(out.Steps) != 1 {
		t.Errorf("Run with zero opts: passed=%v steps=%d, want true / 1", out.Passed, len(out.Steps))
	}
}

func TestRunSkipsEmptyCommands(t *testing.T) {
	requireShell(t)
	// An empty / whitespace-only Cmd is a "step not configured" signal
	// — same shape as TS hasAnyVerifyCommand. The runner must skip it
	// silently (no row in Steps) rather than execute an empty shell
	// invocation.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: successCmd()},
		{Name: "lint", Cmd: ""},
		{Name: "typecheck", Cmd: "   "},
		{Name: "test", Cmd: successCmd()},
	}
	out, _ := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	if len(out.Steps) != 2 {
		t.Fatalf("Steps: got %d rows, want 2 (lint + typecheck skipped)", len(out.Steps))
	}
	if out.Steps[0].Name != "format" || out.Steps[1].Name != "test" {
		t.Errorf("step names: got %q, %q; want format, test", out.Steps[0].Name, out.Steps[1].Name)
	}
}

func TestRunWalksCanonicalOrderRegardlessOfInput(t *testing.T) {
	requireShell(t)
	// Caller passes steps in a weird order; the runner walks
	// format → lint → typecheck → test → build. This keeps recorded
	// step order stable across callers and matches the TS STEP_ORDER
	// constant.
	steps := []runlifecycle.VerifyStep{
		{Name: "build", Cmd: successCmd()},
		{Name: "format", Cmd: successCmd()},
		{Name: "test", Cmd: successCmd()},
	}
	out, _ := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	if len(out.Steps) != 3 {
		t.Fatalf("Steps: got %d, want 3", len(out.Steps))
	}
	want := []string{"format", "test", "build"}
	for i, s := range out.Steps {
		if s.Name != want[i] {
			t.Errorf("Steps[%d].Name: got %q, want %q", i, s.Name, want[i])
		}
	}
}

func TestRunRefusesNewlineInCommand(t *testing.T) {
	// Defensive guard: NUL / CR / LF in a verify command is virtually
	// always a paste accident. The runner must refuse rather than
	// execute, recording a non-zero (nil exit code) row with the
	// bridge marker.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: "echo ok\necho leak"},
	}
	out, _ := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	if len(out.Steps) != 1 {
		t.Fatalf("Steps: got %d, want 1", len(out.Steps))
	}
	row := out.Steps[0]
	if row.OK {
		t.Errorf("OK: got true, want false (newline command must be refused)")
	}
	if row.ExitCode != nil {
		t.Errorf("ExitCode: got %v, want nil (no shell was invoked)", row.ExitCode)
	}
	if !strings.Contains(row.Output, "refused to run verify command") {
		t.Errorf("Output: missing refusal marker; got %q", row.Output)
	}
}

func TestRunRecordsDuration(t *testing.T) {
	requireShell(t)
	// DurationMs must be populated (non-negative) for every recorded
	// step. The exact timing is platform-flaky, so we only assert
	// "set", not a bound.
	steps := []runlifecycle.VerifyStep{
		{Name: "format", Cmd: successCmd()},
	}
	start := time.Now()
	out, _ := runlifecycle.Run(steps, t.TempDir(), runlifecycle.VerifyOptions{
		ShellOverride: shellOverride(),
	})
	wallMs := time.Since(start).Milliseconds()
	if out.Steps[0].DurationMs < 0 {
		t.Errorf("DurationMs: got %d, want ≥ 0", out.Steps[0].DurationMs)
	}
	if out.Steps[0].DurationMs > wallMs+1000 {
		t.Errorf("DurationMs: got %d, want ≤ wall time %d", out.Steps[0].DurationMs, wallMs)
	}
}

// TestWireWithVerifyFiresAfterSpawnHookOnCleanExit asserts the verify
// path also runs the post-exit git step on a clean exit. Without this,
// only the no-verify Wire path honored autoCommit/autoPush — apps that
// opted into both would silently drop the commit half.
func TestWireWithVerifyFiresAfterSpawnHookOnCleanExit(t *testing.T) {
	const sid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var afterSpawnCalls atomic.Int32
	var verifyCalls atomic.Int32
	verifyHook := func(_, _ string) (meta.RunVerify, bool, error) {
		verifyCalls.Add(1)
		return meta.RunVerify{Passed: true}, false, nil
	}
	afterSpawn := func(repoPath, msg string, s git.Settings) error {
		afterSpawnCalls.Add(1)
		return nil
	}
	runlifecycle.WireWithVerifyOpts(dir, sid, done, func() int { return 0 },
		"g-verify-clean", verifyHook, runlifecycle.WireOpts{
			GitSettings: &git.Settings{AutoPush: true},
			RepoPath:    "/fake/repo",
			AfterSpawn:  afterSpawn,
		})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && (verifyCalls.Load() == 0 || afterSpawnCalls.Load() == 0) {
		time.Sleep(5 * time.Millisecond)
	}
	if verifyCalls.Load() != 1 {
		t.Errorf("verify hook calls: got %d, want 1", verifyCalls.Load())
	}
	if afterSpawnCalls.Load() != 1 {
		t.Errorf("AfterSpawn calls: got %d, want 1", afterSpawnCalls.Load())
	}
}

// TestWireWithVerifyRunsAfterSpawnEvenWhenVerifyFails asserts that a
// failing verify chain (advisory, not a status gate) does NOT block
// the auto-commit. CLAUDE.md / verify.go comment: verify is advisory,
// so a verify-fail-but-exit-clean run is still "done" and the bridge
// still owes the commit step.
func TestWireWithVerifyRunsAfterSpawnEvenWhenVerifyFails(t *testing.T) {
	const sid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var afterSpawnCalls atomic.Int32
	verifyHook := func(_, _ string) (meta.RunVerify, bool, error) {
		// Persist=true with Passed=false: the verify chain ran, some
		// step failed, the result is recorded but the run stays done.
		return meta.RunVerify{Passed: false}, true, nil
	}
	afterSpawn := func(repoPath, msg string, s git.Settings) error {
		afterSpawnCalls.Add(1)
		return nil
	}
	runlifecycle.WireWithVerifyOpts(dir, sid, done, func() int { return 0 },
		"g-verify-failed", verifyHook, runlifecycle.WireOpts{
			GitSettings: &git.Settings{AutoCommit: true},
			RepoPath:    "/fake/repo",
			AfterSpawn:  afterSpawn,
		})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && afterSpawnCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if afterSpawnCalls.Load() != 1 {
		t.Errorf("AfterSpawn calls: got %d, want 1 (verify failure must not block git)", afterSpawnCalls.Load())
	}
}

// TestWireWithVerifySkipsHookWhenNil asserts that passing hook=nil
// degrades to plain Wire (with the same opts plumbed through). The
// existing callers in api/tasks_agents.go that don't have a verify
// hook still want autoCommit/autoPush.
func TestWireWithVerifySkipsHookWhenNil(t *testing.T) {
	const sid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var afterSpawnCalls atomic.Int32
	afterSpawn := func(repoPath, msg string, s git.Settings) error {
		afterSpawnCalls.Add(1)
		return nil
	}
	runlifecycle.WireWithVerifyOpts(dir, sid, done, func() int { return 0 },
		"g-verify-nilhook", nil, runlifecycle.WireOpts{
			GitSettings: &git.Settings{AutoCommit: true},
			RepoPath:    "/fake/repo",
			AfterSpawn:  afterSpawn,
		})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && afterSpawnCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if afterSpawnCalls.Load() != 1 {
		t.Errorf("AfterSpawn calls: got %d, want 1 (nil hook must still trigger git)", afterSpawnCalls.Load())
	}
}

// TestWireWithVerifyRecoversFromHookPanic asserts a panicking verify
// hook does NOT crash the goroutine and does NOT demote the run from
// done. The post-exit git step still runs (the run is staying "done").
func TestWireWithVerifyRecoversFromHookPanic(t *testing.T) {
	const sid = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var afterSpawnCalls atomic.Int32
	verifyHook := func(_, _ string) (meta.RunVerify, bool, error) {
		panic("simulated verify hook bug")
	}
	afterSpawn := func(repoPath, msg string, s git.Settings) error {
		afterSpawnCalls.Add(1)
		return nil
	}
	runlifecycle.WireWithVerifyOpts(dir, sid, done, func() int { return 0 },
		"g-verify-panic", verifyHook, runlifecycle.WireOpts{
			GitSettings: &git.Settings{AutoCommit: true},
			RepoPath:    "/fake/repo",
			AfterSpawn:  afterSpawn,
		})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && afterSpawnCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	r := readRun(t, dir, sid)
	if r.Status != meta.RunStatusDone {
		t.Errorf("status: got %q, want done (panic must not demote)", r.Status)
	}
	if afterSpawnCalls.Load() != 1 {
		t.Errorf("AfterSpawn calls: got %d, want 1 (panic must not block git)", afterSpawnCalls.Load())
	}
}

// TestWireWithVerifyRespectsCtxCancel asserts the verify-path
// goroutine also drains on ctx cancel.
func TestWireWithVerifyRespectsCtxCancel(t *testing.T) {
	const sid = "11111111-2222-4333-8444-555566667777"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{}) // never closed
	ctx, cancel := context.WithCancel(context.Background())
	var afterSpawnCalls atomic.Int32
	verifyHook := func(_, _ string) (meta.RunVerify, bool, error) {
		t.Errorf("verify hook must not fire on ctx cancel")
		return meta.RunVerify{}, false, errors.New("should not run")
	}
	afterSpawn := func(repoPath, msg string, s git.Settings) error {
		afterSpawnCalls.Add(1)
		return nil
	}
	runlifecycle.WireWithVerifyOpts(dir, sid, done, func() int { return 0 },
		"g-verify-ctx", verifyHook, runlifecycle.WireOpts{
			Ctx:         ctx,
			GitSettings: &git.Settings{AutoCommit: true},
			RepoPath:    "/fake/repo",
			AfterSpawn:  afterSpawn,
		})
	cancel()
	time.Sleep(50 * time.Millisecond)
	if afterSpawnCalls.Load() != 0 {
		t.Errorf("AfterSpawn calls: got %d, want 0 (ctx cancel must skip git)", afterSpawnCalls.Load())
	}
}
