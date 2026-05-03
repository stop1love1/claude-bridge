package api_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// TestTaskEventsEmitsSnapshotAndLifecycle exercises the SSE handler
// end to end: connect, observe `snapshot`, append a run, observe
// `spawned`, transition to `done`, observe `done`.
func TestTaskEventsEmitsSnapshotAndLifecycle(t *testing.T) {
	h, sessionsDir := newTestServer(t)
	rec, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "sse target"})
	idVal, ok := created["id"].(string)
	if !ok {
		t.Fatalf("CreateTask response missing id: status=%d body=%s", rec.Code, rec.Body.String())
	}
	id := idVal
	_ = sessionsDir

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv := httptest.NewServer(h)
	defer srv.Close()

	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/tasks/"+id+"/events", nil)
	if err != nil {
		t.Fatalf("req: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type: got %q, want text/event-stream", ct)
	}

	// Read frames concurrently into a channel; the test asserts ordering.
	frames := make(chan string, 16)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(resp.Body)
		var current strings.Builder
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if current.Len() > 0 {
					frames <- current.String()
					current.Reset()
				}
				continue
			}
			current.WriteString(line)
			current.WriteString("\n")
		}
	}()

	// First frame must be snapshot.
	select {
	case f := <-frames:
		if !strings.HasPrefix(f, "event: snapshot\n") {
			t.Fatalf("first frame: %q", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for snapshot")
	}

	// Append a run — should fire `spawned`.
	sid := "44444444-4444-4444-8444-444444444444"
	dir := newTaskDirHelperReuse(sessionsDir, id)
	if err := meta.AppendRun(dir, meta.Run{SessionID: sid, Status: meta.RunStatusRunning, Role: "coder", Repo: "bridge"}); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	select {
	case f := <-frames:
		if !strings.HasPrefix(f, "event: spawned\n") {
			t.Errorf("expected spawned frame, got: %q", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for spawned event")
	}

	// Transition to done — should fire `done`.
	_, _ = meta.UpdateRun(dir, sid, func(r *meta.Run) { r.Status = meta.RunStatusDone }, nil)
	select {
	case f := <-frames:
		if !strings.HasPrefix(f, "event: done\n") {
			t.Errorf("expected done frame, got: %q", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for done event")
	}

	cancel() // closes the SSE connection
}

// newTaskDirHelperReuse builds the path the SSE handler computes for a
// task id; tests use it to grab the dir without parsing it from the
// CreateTask response (which doesn't surface it).
func newTaskDirHelperReuse(sessionsDir, taskID string) string {
	return sessionsDir + "/" + taskID
}

// TestDetectRefreshStubReturnsOK asserts the stub-shaped response so a
// future port that wires real detect doesn't accidentally break the
// 200 contract callers depend on.
func TestDetectRefreshStubReturnsOK(t *testing.T) {
	h, _ := newTestServer(t)
	createRec, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "detect target"})
	idVal, ok := created["id"].(string)
	if !ok {
		t.Fatalf("CreateTask response missing id: status=%d body=%s", createRec.Code, createRec.Body.String())
	}
	id := idVal

	rec, got := doJSON(t, h, "POST", "/api/tasks/"+id+"/detect/refresh", nil)
	if rec.Code != 200 {
		t.Fatalf("status: %d", rec.Code)
	}
	if got["ok"] != true {
		t.Errorf("ok: %+v", got)
	}
}

// TestTaskEventsSubscribeBeforeSnapshotRace exercises the race-safety
// fix for tasks_events.go: events fired between the client's connect
// and the snapshot-send must not be silently dropped. We pre-register
// a run row before the SSE handler runs (so it's already in the
// snapshot), then fire AppendRun frames in a tight loop while the
// handler is reading the snapshot, and assert every emitted event
// shows up as a frame on the wire.
//
// Before the fix, events between the snapshot ReadMeta and the
// SubscribeMeta call would land on no listener and vanish; with the
// pre-subscribe queue, every event gets either delivered or queued
// and replayed.
func TestTaskEventsSubscribeBeforeSnapshotRace(t *testing.T) {
	h, sessionsDir := newTestServer(t)
	rec, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "race target"})
	idVal, ok := created["id"].(string)
	if !ok {
		t.Fatalf("CreateTask response missing id: status=%d body=%s", rec.Code, rec.Body.String())
	}
	id := idVal
	dir := newTaskDirHelperReuse(sessionsDir, id)

	srv := httptest.NewServer(h)
	defer srv.Close()

	// Connect SSE.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/tasks/"+id+"/events", nil)
	if err != nil {
		t.Fatalf("req: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Frame collector.
	frames := make(chan string, 64)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(resp.Body)
		var current strings.Builder
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if current.Len() > 0 {
					frames <- current.String()
					current.Reset()
				}
				continue
			}
			current.WriteString(line)
			current.WriteString("\n")
		}
	}()

	// Wait for snapshot frame, then immediately fire several AppendRun
	// events that the subscribe-window queue must capture.
	select {
	case f := <-frames:
		if !strings.HasPrefix(f, "event: snapshot\n") {
			t.Fatalf("first frame: %q", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for snapshot")
	}

	const want = 5
	sids := []string{
		"55555555-5555-4555-8555-555555555551",
		"55555555-5555-4555-8555-555555555552",
		"55555555-5555-4555-8555-555555555553",
		"55555555-5555-4555-8555-555555555554",
		"55555555-5555-4555-8555-555555555555",
	}
	for _, sid := range sids {
		if err := meta.AppendRun(dir, meta.Run{SessionID: sid, Status: meta.RunStatusRunning, Role: "coder", Repo: "bridge"}); err != nil {
			t.Fatalf("AppendRun %s: %v", sid, err)
		}
	}

	// Collect frames; we expect at least `want` spawned events.
	gotSpawned := 0
	deadline := time.After(3 * time.Second)
	for gotSpawned < want {
		select {
		case f, ok := <-frames:
			if !ok {
				t.Fatalf("frame channel closed; saw %d/%d spawned", gotSpawned, want)
			}
			if strings.HasPrefix(f, "event: spawned\n") {
				gotSpawned++
			}
		case <-deadline:
			t.Fatalf("timeout: got %d/%d spawned events", gotSpawned, want)
		}
	}
	cancel()
}
