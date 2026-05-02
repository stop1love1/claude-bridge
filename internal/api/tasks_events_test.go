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
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "sse target"})
	id := created["id"].(string)
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
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "detect target"})
	id := created["id"].(string)

	rec, got := doJSON(t, h, "POST", "/api/tasks/"+id+"/detect/refresh", nil)
	if rec.Code != 200 {
		t.Fatalf("status: %d", rec.Code)
	}
	if got["ok"] != true {
		t.Errorf("ok: %+v", got)
	}
}
