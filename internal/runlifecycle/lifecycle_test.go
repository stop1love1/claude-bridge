package runlifecycle_test

import (
	"path/filepath"
	"testing"
	"time"

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
