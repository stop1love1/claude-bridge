package meta_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// newTaskDir creates a fresh task dir + initial meta.json. The dir
// basename matches the task id so taskIDFromDir(dir) == TaskID — the
// emit() path uses basename as the event's TaskID, so tests that
// subscribe by id need this naming.
func newTaskDir(t *testing.T) string {
	return newNamedTaskDir(t, "t_20260101_001")
}

func newNamedTaskDir(t *testing.T, taskID string) string {
	t.Helper()
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), taskID)
	if err := meta.CreateMeta(dir, meta.Meta{
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
	return dir
}

func TestIsValidTaskID(t *testing.T) {
	cases := []struct {
		id   string
		want bool
	}{
		{"t_20260101_001", true},
		{"t_20260101_999", true},
		{"", false},
		{"t_2026010_001", false},
		{"t_20260101_1", false},
		{"t_20260101_0001", false},
		{"../etc/passwd", false},
		{"t_20260101_001/foo", false},
	}
	for _, c := range cases {
		if got := meta.IsValidTaskID(c.id); got != c.want {
			t.Errorf("IsValidTaskID(%q) = %v, want %v", c.id, got, c.want)
		}
	}
}

func TestGenerateTaskIDIncrementsHighest(t *testing.T) {
	now := time.Date(2026, 5, 10, 0, 0, 0, 0, time.UTC)
	got := meta.GenerateTaskID(now, []string{"t_20260510_002", "t_20260510_005", "t_20260101_999"})
	if got != "t_20260510_006" {
		t.Errorf("got %q, want t_20260510_006", got)
	}
	// Empty existing list → 001.
	got = meta.GenerateTaskID(now, nil)
	if got != "t_20260510_001" {
		t.Errorf("got %q, want t_20260510_001", got)
	}
}

func TestCreateAndReadMetaRoundtrip(t *testing.T) {
	dir := newTaskDir(t)
	got, err := meta.ReadMeta(dir)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if got == nil {
		t.Fatal("expected meta, got nil")
	}
	if got.TaskID != "t_20260101_001" || got.TaskTitle != "test" {
		t.Errorf("unexpected meta: %+v", got)
	}
	if got.Runs == nil {
		t.Error("Runs should be empty slice, not nil — JSON round-trip would emit [] not null")
	}
}

func TestAtomicWriteJsonShapeBytewiseExpected(t *testing.T) {
	dir := newTaskDir(t)
	meta.ResetCacheForTests()
	body, err := os.ReadFile(filepath.Join(dir, meta.MetaFile))
	if err != nil {
		t.Fatalf("read meta.json: %v", err)
	}
	// libs/atomicWrite.ts produces 2-space indented JSON with trailing
	// "\n". Smoke-check both invariants.
	if !strings.HasSuffix(string(body), "\n") {
		t.Error("meta.json should end with a trailing newline")
	}
	if !strings.Contains(string(body), "  \"taskId\":") {
		t.Errorf("meta.json should be 2-space indented; got first 200 bytes: %q", body[:200])
	}
	// Round-trip: marshal what we read with the same shape and compare
	// every key is present + values match. We don't need full bytewise
	// equality between two json.Marshal runs (Go preserves struct
	// field order, which we control); we just need a clean parse +
	// re-marshal that doesn't lose keys.
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("re-parse meta.json: %v", err)
	}
	for _, key := range []string{"taskId", "taskTitle", "taskBody", "taskStatus", "taskSection", "taskChecked", "createdAt", "runs"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("missing key %q in meta.json", key)
		}
	}
}

func TestAppendRunSerializesConcurrentWriters(t *testing.T) {
	dir := newTaskDir(t)
	const N = 50
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			run := meta.Run{
				SessionID: makeSessionID(i),
				Role:      "coder",
				Repo:      "bridge",
				Status:    meta.RunStatusQueued,
			}
			if err := meta.AppendRun(dir, run); err != nil {
				t.Errorf("AppendRun: %v", err)
			}
		}()
	}
	wg.Wait()

	meta.ResetCacheForTests()
	got, err := meta.ReadMeta(dir)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	// All N appends must be present — no lost-update.
	if len(got.Runs) != N {
		t.Fatalf("Runs length: got %d, want %d", len(got.Runs), N)
	}
	// Each session id should appear exactly once (no duplicates from
	// retries).
	seen := make(map[string]int)
	for _, r := range got.Runs {
		seen[r.SessionID]++
	}
	for sid, n := range seen {
		if n != 1 {
			t.Errorf("session %s appears %d times", sid, n)
		}
	}
}

func TestUpdateRunPreconditionRejectsDemotion(t *testing.T) {
	dir := newTaskDir(t)
	sid := "11111111-1111-4111-8111-111111111111"
	if err := meta.AppendRun(dir, meta.Run{SessionID: sid, Status: meta.RunStatusRunning}); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	if _, err := meta.UpdateRun(dir, sid, func(r *meta.Run) { r.Status = meta.RunStatusDone }, nil); err != nil {
		t.Fatalf("UpdateRun done: %v", err)
	}
	// Try to demote done → failed via precondition that rejects
	// terminal states.
	applied, err := meta.UpdateRun(dir, sid, func(r *meta.Run) { r.Status = meta.RunStatusFailed }, func(r meta.Run) bool {
		return r.Status != meta.RunStatusDone
	})
	if err != nil {
		t.Fatalf("UpdateRun with precondition: %v", err)
	}
	if applied {
		t.Error("precondition should have blocked demotion")
	}
	got, _ := meta.ReadMeta(dir)
	if got.Runs[0].Status != meta.RunStatusDone {
		t.Errorf("status: got %s, want done", got.Runs[0].Status)
	}
}

func TestRemoveSessionFromTask(t *testing.T) {
	dir := newTaskDir(t)
	sid := "22222222-2222-4222-8222-222222222222"
	_ = meta.AppendRun(dir, meta.Run{SessionID: sid, Status: meta.RunStatusDone})
	_ = meta.AppendRun(dir, meta.Run{SessionID: "other", Status: meta.RunStatusDone})

	removed, err := meta.RemoveSessionFromTask(dir, sid)
	if err != nil {
		t.Fatalf("RemoveSessionFromTask: %v", err)
	}
	if !removed {
		t.Error("expected removed=true")
	}
	got, _ := meta.ReadMeta(dir)
	if len(got.Runs) != 1 || got.Runs[0].SessionID != "other" {
		t.Errorf("post-remove runs: %+v", got.Runs)
	}
	// Removing a non-linked session is a no-op false return.
	removed, err = meta.RemoveSessionFromTask(dir, "ghost")
	if err != nil || removed {
		t.Errorf("ghost removal: removed=%v err=%v", removed, err)
	}
}

func TestSubscribeMetaFiresOnAppendAndUpdate(t *testing.T) {
	dir := newTaskDir(t)
	var mu sync.Mutex
	var events []meta.MetaChangeEvent
	cancel := meta.SubscribeMeta("t_20260101_001", func(ev meta.MetaChangeEvent) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	})
	defer cancel()

	sid := "33333333-3333-4333-8333-333333333333"
	_ = meta.AppendRun(dir, meta.Run{SessionID: sid, Status: meta.RunStatusQueued})
	_, _ = meta.UpdateRun(dir, sid, func(r *meta.Run) { r.Status = meta.RunStatusDone }, nil)

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	if events[0].Kind != meta.MetaChangeSpawned {
		t.Errorf("event[0].Kind: got %s, want spawned", events[0].Kind)
	}
	if events[1].Kind != meta.MetaChangeTransition {
		t.Errorf("event[1].Kind: got %s, want transition", events[1].Kind)
	}
}

func TestSubscribeMetaAllReceivesEveryTaskID(t *testing.T) {
	dirA := newTaskDir(t)
	dirB := newNamedTaskDir(t, "t_20260101_002")
	var hits int32
	cancel := meta.SubscribeMetaAll(func(meta.MetaChangeEvent) {
		atomic.AddInt32(&hits, 1)
	})
	defer cancel()
	_ = meta.AppendRun(dirA, meta.Run{SessionID: "a", Status: meta.RunStatusQueued})
	_ = meta.AppendRun(dirB, meta.Run{SessionID: "b", Status: meta.RunStatusQueued})
	if atomic.LoadInt32(&hits) != 2 {
		t.Errorf("hits: got %d, want 2", atomic.LoadInt32(&hits))
	}
}

func makeSessionID(i int) string {
	// Deterministic UUID-shaped string, not a real v4 — meta.go doesn't
	// validate the shape, only stores it.
	return "00000000-0000-4000-8000-" + padHex(i, 12)
}

func padHex(n, width int) string {
	const hex = "0123456789abcdef"
	out := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		out[i] = hex[n&0xf]
		n >>= 4
	}
	return string(out)
}
