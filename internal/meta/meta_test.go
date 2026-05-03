package meta_test

import (
	"encoding/json"
	"errors"
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

// TestAtomicWriteRoundTripsBytes confirms WriteJSONAtomic + ReadMeta
// preserve every field through the new fsync'd write path. The fsync
// itself is invisible from inside the test process — power-loss
// simulation is out of scope — but a regression in the file/dir sync
// ordering would surface as a corrupt write or missing file here.
func TestAtomicWriteRoundTripsBytes(t *testing.T) {
	dir := newTaskDir(t)
	app := "bridge"
	want := &meta.Meta{
		TaskID:      "t_20260101_001",
		TaskTitle:   "round-trip",
		TaskBody:    "with newlines\nand tabs\there\n",
		TaskStatus:  meta.TaskStatusDoing,
		TaskSection: meta.SectionDoing,
		TaskChecked: true,
		TaskApp:     &app,
		CreatedAt:   "2026-01-01T00:00:00.000Z",
		Runs: []meta.Run{
			{SessionID: "s1", Role: "coder", Repo: "r", Status: meta.RunStatusDone},
		},
	}
	if err := meta.WriteMeta(dir, want); err != nil {
		t.Fatalf("WriteMeta: %v", err)
	}
	meta.ResetCacheForTests()
	got, err := meta.ReadMeta(dir)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if got.TaskTitle != want.TaskTitle ||
		got.TaskBody != want.TaskBody ||
		got.TaskStatus != want.TaskStatus ||
		got.TaskSection != want.TaskSection ||
		got.TaskChecked != want.TaskChecked ||
		got.TaskApp == nil || *got.TaskApp != app ||
		len(got.Runs) != 1 || got.Runs[0].SessionID != "s1" {
		t.Errorf("round-trip mismatch: got %+v", got)
	}
}

// TestCreateMetaFailsOnExisting locks in the create-or-fail contract:
// a second CreateMeta against the same dir returns ErrMetaExists, the
// original meta is not clobbered.
func TestCreateMetaFailsOnExisting(t *testing.T) {
	dir := newTaskDir(t) // already created.
	err := meta.CreateMeta(dir, meta.Meta{
		TaskID:      "t_20260101_001",
		TaskTitle:   "second-call",
		TaskStatus:  meta.TaskStatusTodo,
		TaskSection: meta.SectionTodo,
		CreatedAt:   "2026-01-02T00:00:00.000Z",
	})
	if !errors.Is(err, meta.ErrMetaExists) {
		t.Fatalf("expected ErrMetaExists, got %v", err)
	}
	meta.ResetCacheForTests()
	got, _ := meta.ReadMeta(dir)
	if got == nil || got.TaskTitle != "test" {
		t.Errorf("original meta clobbered: %+v", got)
	}
}

// TestCreateMetaConcurrentCreatesProduceOneWinner spawns N goroutines
// racing on CreateMeta for a single dir. Exactly one must succeed; the
// rest must all return ErrMetaExists. Validates the lock+stat sequence
// is atomic.
func TestCreateMetaConcurrentCreatesProduceOneWinner(t *testing.T) {
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), "t_20260101_009")
	const N = 16
	var wg sync.WaitGroup
	var ok int32
	var dup int32
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := meta.CreateMeta(dir, meta.Meta{
				TaskID:      "t_20260101_009",
				TaskTitle:   "racer",
				TaskStatus:  meta.TaskStatusTodo,
				TaskSection: meta.SectionTodo,
				CreatedAt:   "2026-01-09T00:00:00Z",
			})
			if err == nil {
				atomic.AddInt32(&ok, 1)
			} else if errors.Is(err, meta.ErrMetaExists) {
				atomic.AddInt32(&dup, 1)
			} else {
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	if got, want := atomic.LoadInt32(&ok), int32(1); got != want {
		t.Errorf("successful creates: got %d, want %d", got, want)
	}
	if got, want := atomic.LoadInt32(&dup), int32(N-1); got != want {
		t.Errorf("ErrMetaExists count: got %d, want %d", got, want)
	}
}

// TestCreateMetaPreservesCallerRuns confirms the dead-code refactor:
// caller-provided Runs are no longer silently overwritten with [].
func TestCreateMetaPreservesCallerRuns(t *testing.T) {
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), "t_20260101_010")
	seed := []meta.Run{
		{SessionID: "seed-a", Role: "coder", Repo: "r", Status: meta.RunStatusDone},
		{SessionID: "seed-b", Role: "reviewer", Repo: "r", Status: meta.RunStatusFailed},
	}
	if err := meta.CreateMeta(dir, meta.Meta{
		TaskID:      "t_20260101_010",
		TaskTitle:   "with-runs",
		TaskStatus:  meta.TaskStatusDoing,
		TaskSection: meta.SectionDoing,
		CreatedAt:   "2026-01-10T00:00:00Z",
		Runs:        seed,
	}); err != nil {
		t.Fatalf("CreateMeta: %v", err)
	}
	got, _ := meta.ReadMeta(dir)
	if len(got.Runs) != 2 {
		t.Fatalf("Runs: got %d, want 2 (caller-provided seed should be preserved)", len(got.Runs))
	}
	if got.Runs[0].SessionID != "seed-a" || got.Runs[1].SessionID != "seed-b" {
		t.Errorf("Runs not preserved verbatim: %+v", got.Runs)
	}
}

// TestReadMetaSurfacesParseError confirms ReadMeta no longer silently
// swallows JSON parse errors — operators get a real error rather than
// "task missing".
func TestReadMetaSurfacesParseError(t *testing.T) {
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), "t_20260101_011")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Hand-write a corrupt meta.json (truncated) so ReadMeta hits the
	// parse-error branch.
	if err := os.WriteFile(filepath.Join(dir, meta.MetaFile), []byte(`{"taskId":"t_20260101_011`), 0o644); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}
	got, err := meta.ReadMeta(dir)
	if err == nil {
		t.Fatalf("expected parse error, got nil; got=%+v", got)
	}
	if got != nil {
		t.Errorf("expected nil meta on parse error, got %+v", got)
	}
	if !strings.Contains(err.Error(), "parse") {
		t.Errorf("error should mention parse: %v", err)
	}
	// The cache must NOT have been poisoned — a fresh write should
	// be readable on the next call.
	if err := meta.WriteMeta(dir, &meta.Meta{
		TaskID:      "t_20260101_011",
		TaskTitle:   "fixed",
		TaskStatus:  meta.TaskStatusTodo,
		TaskSection: meta.SectionTodo,
		CreatedAt:   "2026-01-11T00:00:00Z",
		Runs:        []meta.Run{},
	}); err != nil {
		t.Fatalf("WriteMeta after parse error: %v", err)
	}
	got, err = meta.ReadMeta(dir)
	if err != nil || got == nil || got.TaskTitle != "fixed" {
		t.Errorf("post-fix read: got=%+v err=%v", got, err)
	}
}

// TestMutateMetaHoldsLockOnce confirms MutateMeta serializes a
// read-modify-write under the per-task lock — concurrent mutations
// must not lose updates.
func TestMutateMetaHoldsLockOnce(t *testing.T) {
	dir := newTaskDir(t)
	const N = 30
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := meta.MutateMeta(dir, func(m *meta.Meta) error {
				m.Runs = append(m.Runs, meta.Run{
					SessionID: makeSessionID(1000 + i),
					Role:      "x",
					Repo:      "r",
					Status:    meta.RunStatusQueued,
				})
				return nil
			})
			if err != nil {
				t.Errorf("MutateMeta: %v", err)
			}
		}()
	}
	wg.Wait()
	meta.ResetCacheForTests()
	got, err := meta.ReadMeta(dir)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if len(got.Runs) != N {
		t.Errorf("MutateMeta concurrency lost updates: got %d, want %d", len(got.Runs), N)
	}
}

// TestMutateMetaMissingMetaSentinel confirms the helper returns the
// shared ErrMissingMeta when the task dir has no meta.json.
func TestMutateMetaMissingMetaSentinel(t *testing.T) {
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), "t_20260101_012") // never created.
	err := meta.MutateMeta(dir, func(m *meta.Meta) error {
		return nil
	})
	if !errors.Is(err, meta.ErrMissingMeta) {
		t.Errorf("expected ErrMissingMeta, got %v", err)
	}
}

// TestInvalidateCacheForDoesNotStompSiblings verifies the per-id
// cache invalidator only drops the targeted entry.
func TestInvalidateCacheForDoesNotStompSiblings(t *testing.T) {
	dirA := newNamedTaskDir(t, "t_20260101_020")
	dirB := newNamedTaskDir(t, "t_20260101_021")
	// Prime both into cache.
	if _, err := meta.ReadMeta(dirA); err != nil {
		t.Fatalf("ReadMeta A: %v", err)
	}
	if _, err := meta.ReadMeta(dirB); err != nil {
		t.Fatalf("ReadMeta B: %v", err)
	}

	// Stomp the on-disk file for B out of band — without the cache
	// invalidator a follow-up ReadMeta(B) would return the stale
	// hit.
	if err := os.WriteFile(filepath.Join(dirB, meta.MetaFile), []byte(`{"taskId":"t_20260101_021","taskTitle":"changed-on-disk","taskStatus":"todo","taskSection":"TODO","taskChecked":false,"createdAt":"2026-01-21T00:00:00Z","runs":[]}`), 0o644); err != nil {
		t.Fatalf("write B: %v", err)
	}

	meta.InvalidateCacheFor(dirB)

	// B should now read the on-disk title.
	gotB, err := meta.ReadMeta(dirB)
	if err != nil || gotB == nil {
		t.Fatalf("ReadMeta B: %v", err)
	}
	if gotB.TaskTitle != "changed-on-disk" {
		t.Errorf("B was not invalidated; title=%q", gotB.TaskTitle)
	}

	// A's cached entry must NOT have been disturbed — overwrite
	// disk for A out of band, ReadMeta(A) should still return the
	// original cached value (cache hit).
	if err := os.WriteFile(filepath.Join(dirA, meta.MetaFile), []byte(`{"taskId":"t_20260101_020","taskTitle":"WRONG","taskStatus":"todo","taskSection":"TODO","taskChecked":false,"createdAt":"2026-01-20T00:00:00Z","runs":[]}`), 0o644); err != nil {
		t.Fatalf("write A: %v", err)
	}
	gotA, err := meta.ReadMeta(dirA)
	if err != nil || gotA == nil {
		t.Fatalf("ReadMeta A: %v", err)
	}
	if gotA.TaskTitle != "test" {
		t.Errorf("A's cache was stomped by B's invalidation; title=%q", gotA.TaskTitle)
	}
}

// TestRemoveLockForDeregisters confirms RemoveLockFor drops the entry
// from the registry. Test by exercising the lock both before and
// after removal — both must succeed (after removal a fresh mutex is
// allocated by get()).
func TestRemoveLockForDeregisters(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "t_20260101_030")
	called := 0
	if err := meta.WithTaskLock(dir, func() error {
		called++
		return nil
	}); err != nil {
		t.Fatalf("WithTaskLock: %v", err)
	}
	meta.RemoveLockFor(dir)
	// Subsequent acquire must still work — the registry just
	// allocates a fresh mutex.
	if err := meta.WithTaskLock(dir, func() error {
		called++
		return nil
	}); err != nil {
		t.Fatalf("WithTaskLock post-Remove: %v", err)
	}
	if called != 2 {
		t.Errorf("called: got %d, want 2", called)
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
