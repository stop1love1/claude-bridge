package runlifecycle_test

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/runlifecycle"
)

// newTaskDirWithRun creates a fresh task dir with one running run named
// sessionID. Mirrors the meta_test helper but we re-implement here to
// avoid a cross-package test dependency.
func newTaskDirWithRun(t *testing.T, sessionID string) string {
	t.Helper()
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), "t_20260101_001")
	if err := meta.CreateMeta(dir, meta.Meta{
		TaskID:      "t_20260101_001",
		TaskTitle:   "test",
		TaskBody:    "body",
		TaskStatus:  meta.TaskStatusTodo,
		TaskSection: meta.SectionTodo,
		TaskChecked: false,
		CreatedAt:   "2026-01-01T00:00:00.000Z",
	}); err != nil {
		t.Fatalf("CreateMeta: %v", err)
	}
	startedAt := "2026-01-01T00:00:00.000Z"
	if err := meta.AppendRun(dir, meta.Run{
		SessionID: sessionID,
		Role:      "coder",
		Repo:      "claude-bridge",
		Status:    meta.RunStatusRunning,
		StartedAt: &startedAt,
	}); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	return dir
}

// readRun pulls the named run out of meta.json. Fatal if missing.
func readRun(t *testing.T, dir, sessionID string) meta.Run {
	t.Helper()
	meta.ResetCacheForTests()
	m, err := meta.ReadMeta(dir)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if m == nil {
		t.Fatalf("ReadMeta: meta missing")
	}
	for _, r := range m.Runs {
		if r.SessionID == sessionID {
			return r
		}
	}
	t.Fatalf("run %q not found in %d runs", sessionID, len(m.Runs))
	return meta.Run{}
}

// waitForStatus polls meta.json until the run's status equals want or
// the deadline elapses. Necessary because Wire dispatches a goroutine —
// closing the channel returns control immediately, the patch happens
// asynchronously.
func waitForStatus(t *testing.T, dir, sessionID string, want meta.RunStatus) meta.Run {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r := readRun(t, dir, sessionID)
		if r.Status == want {
			return r
		}
		time.Sleep(5 * time.Millisecond)
	}
	got := readRun(t, dir, sessionID)
	t.Fatalf("status: got %q, want %q after timeout", got.Status, want)
	return meta.Run{}
}

func TestWireFlipsRunningToDoneOnZeroExit(t *testing.T) {
	const sid = "11111111-1111-4111-8111-111111111111"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	runlifecycle.Wire(dir, sid, done, func() int { return 0 }, "coder")
	close(done)
	r := waitForStatus(t, dir, sid, meta.RunStatusDone)
	if r.EndedAt == nil || *r.EndedAt == "" {
		t.Errorf("EndedAt: want non-empty timestamp, got %v", r.EndedAt)
	}
}

func TestWireFlipsRunningToFailedOnNonZeroExit(t *testing.T) {
	const sid = "22222222-2222-4222-8222-222222222222"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	runlifecycle.Wire(dir, sid, done, func() int { return 1 }, "coder")
	close(done)
	r := waitForStatus(t, dir, sid, meta.RunStatusFailed)
	if r.EndedAt == nil || *r.EndedAt == "" {
		t.Errorf("EndedAt: want non-empty timestamp, got %v", r.EndedAt)
	}
}

func TestWireDoesNotDemoteAlreadyDoneRun(t *testing.T) {
	// Simulates the /link race: an external writer (the link API in
	// production, the test here) flipped the run to "done" before the
	// child's exit signal landed. The lifecycle goroutine must NOT
	// demote it back to "failed" even though exit code is non-zero.
	const sid = "33333333-3333-4333-8333-333333333333"
	dir := newTaskDirWithRun(t, sid)
	endedAt := "2026-01-01T00:00:01.000Z"
	if _, err := meta.UpdateRun(dir, sid, func(r *meta.Run) {
		r.Status = meta.RunStatusDone
		r.EndedAt = &endedAt
	}, nil); err != nil {
		t.Fatalf("pre-promote: %v", err)
	}
	done := make(chan struct{})
	runlifecycle.Wire(dir, sid, done, func() int { return 137 }, "killed-but-already-done")
	close(done)
	// Give the goroutine plenty of time to (incorrectly) demote.
	time.Sleep(50 * time.Millisecond)
	r := readRun(t, dir, sid)
	if r.Status != meta.RunStatusDone {
		t.Errorf("status: got %q, want done (precondition should have rejected)", r.Status)
	}
	if r.EndedAt == nil || *r.EndedAt != endedAt {
		t.Errorf("EndedAt: got %v, want %q (must not be overwritten)", r.EndedAt, endedAt)
	}
}

func TestWireToleratesMissingRun(t *testing.T) {
	// Task dir exists but the named sessionID was never appended (the
	// /link path can race with task deletion, or the operator may have
	// removed the run via DELETE /api/sessions/<id>). UpdateRun returns
	// ErrRunNotFound; the lifecycle goroutine logs and exits cleanly
	// rather than crashing the bridge.
	const sid = "44444444-4444-4444-8444-444444444444"
	dir := newTaskDirWithRun(t, "other-session")
	done := make(chan struct{})
	runlifecycle.Wire(dir, sid, done, func() int { return 0 }, "ghost")
	close(done)
	// Sleep until the goroutine has had time to run; nothing observable
	// to assert beyond "no panic" — readRun on the actual run should
	// still show it untouched.
	time.Sleep(50 * time.Millisecond)
	r := readRun(t, dir, "other-session")
	if r.Status != meta.RunStatusRunning {
		t.Errorf("status of unrelated run: got %q, want running", r.Status)
	}
}

func TestWireToleratesMissingMeta(t *testing.T) {
	// Pointing Wire at a nonexistent task dir must not panic — the
	// child's parent task may have been archived during the run.
	const sid = "55555555-5555-4555-8555-555555555555"
	dir := filepath.Join(t.TempDir(), "nonexistent-task")
	done := make(chan struct{})
	runlifecycle.Wire(dir, sid, done, func() int { return 0 }, "orphan")
	close(done)
	time.Sleep(50 * time.Millisecond)
	// No assertion beyond not crashing; the test framework catches a
	// panic in the spawned goroutine via runtime.Goexit handling.
}

func TestWireRecoversFromExitCodePanic(t *testing.T) {
	// A buggy caller might wire Wire before the underlying process has
	// actually exited (ProcessState would be nil → ExitCode() panics on
	// some platforms). The goroutine recovers, treats the run as
	// failed, and keeps the bridge alive.
	const sid = "66666666-6666-4666-8666-666666666666"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	runlifecycle.Wire(dir, sid, done, func() int { panic("ProcessState was nil") }, "panicky")
	close(done)
	r := waitForStatus(t, dir, sid, meta.RunStatusFailed)
	if r.EndedAt == nil {
		t.Errorf("EndedAt: want non-empty after panic recovery")
	}
}

// TestWireWithOptsFiresAfterSpawnHookOnCleanExit asserts the post-exit
// git step runs when GitSettings.AutoCommit is true and the child
// exited cleanly. CLAUDE.md (Per-app git workflow): "After a child run
// succeeds, the bridge optionally runs `git add -A && git commit && git
// push` per the app's autoCommit / autoPush flags." Until this opt was
// wired, the bridge silently dropped the contract.
func TestWireWithOptsFiresAfterSpawnHookOnCleanExit(t *testing.T) {
	const sid = "77777777-7777-4777-8777-777777777777"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var calls atomic.Int32
	var capturedRepo, capturedMsg string
	hook := func(repoPath, msg string, s git.Settings) error {
		calls.Add(1)
		capturedRepo = repoPath
		capturedMsg = msg
		return nil
	}
	runlifecycle.WireWithOpts(dir, sid, done, func() int { return 0 }, "g-coder", runlifecycle.WireOpts{
		GitSettings:   &git.Settings{AutoCommit: true},
		RepoPath:      "/fake/repo",
		CommitMessage: "test commit",
		AfterSpawn:    hook,
	})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	// Hook is async; give the goroutine a beat to fire it after the
	// patch lands.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && calls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("AfterSpawn calls: got %d, want 1", calls.Load())
	}
	if capturedRepo != "/fake/repo" {
		t.Errorf("AfterSpawn repoPath: got %q, want %q", capturedRepo, "/fake/repo")
	}
	if capturedMsg != "test commit" {
		t.Errorf("AfterSpawn msg: got %q, want %q", capturedMsg, "test commit")
	}
}

// TestWireWithOptsSkipsAfterSpawnHookOnNonZeroExit asserts the post-
// exit git step is NOT fired when the child crashed. A failed child's
// working tree is in an unknown state — auto-committing would persist
// garbage.
func TestWireWithOptsSkipsAfterSpawnHookOnNonZeroExit(t *testing.T) {
	const sid = "88888888-8888-4888-8888-888888888888"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var calls atomic.Int32
	hook := func(repoPath, msg string, s git.Settings) error {
		calls.Add(1)
		return nil
	}
	runlifecycle.WireWithOpts(dir, sid, done, func() int { return 1 }, "g-coder-fail", runlifecycle.WireOpts{
		GitSettings: &git.Settings{AutoCommit: true},
		RepoPath:    "/fake/repo",
		AfterSpawn:  hook,
	})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusFailed)
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Errorf("AfterSpawn calls: got %d, want 0 (must not fire on non-zero exit)", calls.Load())
	}
}

// TestWireWithOptsSkipsAfterSpawnHookWhenFlagsOff asserts the hook is
// not even looked at when both AutoCommit and AutoPush are false. The
// vast majority of apps run in this mode (operator commits manually);
// the bridge must not pay the cost of a git shell-out per child.
func TestWireWithOptsSkipsAfterSpawnHookWhenFlagsOff(t *testing.T) {
	const sid = "99999999-9999-4999-8999-999999999999"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	var calls atomic.Int32
	hook := func(repoPath, msg string, s git.Settings) error {
		calls.Add(1)
		return nil
	}
	runlifecycle.WireWithOpts(dir, sid, done, func() int { return 0 }, "g-coder-quiet", runlifecycle.WireOpts{
		GitSettings: &git.Settings{}, // both flags zero
		RepoPath:    "/fake/repo",
		AfterSpawn:  hook,
	})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Errorf("AfterSpawn calls: got %d, want 0 (no flags set)", calls.Load())
	}
}

// TestWireWithOptsDoesNotDemoteOnAfterSpawnError asserts that a failing
// git step does NOT flip the run from "done" back to "failed".
// CLAUDE.md is explicit: "Failures are logged but never flip a
// successful run to failed."
func TestWireWithOptsDoesNotDemoteOnAfterSpawnError(t *testing.T) {
	const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	hook := func(repoPath, msg string, s git.Settings) error {
		return errors.New("simulated git push failure")
	}
	runlifecycle.WireWithOpts(dir, sid, done, func() int { return 0 }, "g-coder-pushfail", runlifecycle.WireOpts{
		GitSettings: &git.Settings{AutoPush: true},
		RepoPath:    "/fake/repo",
		AfterSpawn:  hook,
	})
	close(done)
	waitForStatus(t, dir, sid, meta.RunStatusDone)
	// Sleep past the hook fire so we can assert the status didn't
	// flip after the error.
	time.Sleep(50 * time.Millisecond)
	r := readRun(t, dir, sid)
	if r.Status != meta.RunStatusDone {
		t.Errorf("status: got %q, want done (failed git step must not demote)", r.Status)
	}
}

// TestWireWithOptsOuterPanicGuardKeepsRunDone asserts that when the
// goroutine's exitCode panics AND the AfterSpawn hook also panics, the
// status flip to "done" still lands and the test process survives.
// Without the outer recover, a panic in runAfterSpawn could escape the
// goroutine and crash the bridge. The exitCode-panic case is recovered
// inline (treated as code = -1 → "failed"), so to exercise the clean-
// exit AfterSpawn path with a panicking hook we use exitCode = 0 and
// a hook that panics; the run must end in "done" regardless. Note:
// runAfterSpawn already has its own recover (defense in depth), so
// this also confirms we haven't regressed that.
func TestWireWithOptsOuterPanicGuardKeepsRunDone(t *testing.T) {
	const sid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{})
	hook := func(repoPath, msg string, s git.Settings) error {
		panic("simulated git hook panic")
	}
	runlifecycle.WireWithOpts(dir, sid, done, func() int { return 0 }, "panic-coder", runlifecycle.WireOpts{
		GitSettings: &git.Settings{AutoCommit: true},
		RepoPath:    "/fake/repo",
		AfterSpawn:  hook,
	})
	close(done)
	r := waitForStatus(t, dir, sid, meta.RunStatusDone)
	if r.EndedAt == nil {
		t.Errorf("EndedAt: want non-empty after panic recovery")
	}
	// Beat for the (already-recovered) panicking hook to have fired
	// and the goroutine to have unwound through the outer recover.
	time.Sleep(50 * time.Millisecond)
	// If the test process is alive at this point, the outer guard did
	// its job. Re-check status didn't get demoted.
	r2 := readRun(t, dir, sid)
	if r2.Status != meta.RunStatusDone {
		t.Errorf("status: got %q, want done after panicking hook", r2.Status)
	}
}

// TestWireWithOptsRespectsCtxCancel asserts the goroutine drains on
// ctx.Done when the child's done channel never closes. Without this,
// a caller bug or a never-exiting child would leak the goroutine for
// the lifetime of the process.
func TestWireWithOptsRespectsCtxCancel(t *testing.T) {
	const sid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	dir := newTaskDirWithRun(t, sid)
	done := make(chan struct{}) // intentionally never closed
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	hook := func(repoPath, msg string, s git.Settings) error {
		calls.Add(1)
		return nil
	}
	runlifecycle.WireWithOpts(dir, sid, done, func() int {
		t.Errorf("exitCode must not be called when ctx fires before done")
		return 0
	}, "g-coder-ctx", runlifecycle.WireOpts{
		Ctx:         ctx,
		GitSettings: &git.Settings{AutoCommit: true},
		RepoPath:    "/fake/repo",
		AfterSpawn:  hook,
	})
	cancel()
	// The run stays running — operators see it on next start, the
	// reaper handles the stale flip. We only assert "no panic, no
	// AfterSpawn call, no crash" here.
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Errorf("AfterSpawn calls: got %d, want 0 (ctx cancel must skip git)", calls.Load())
	}
	r := readRun(t, dir, sid)
	if r.Status != meta.RunStatusRunning {
		t.Errorf("status: got %q, want running (ctx cancel must not patch)", r.Status)
	}
}
