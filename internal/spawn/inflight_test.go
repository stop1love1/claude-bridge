package spawn_test

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/spawn"
)

func TestGateAcquireReleaseDedup(t *testing.T) {
	g := spawn.NewGate()
	if !g.Acquire("k") {
		t.Fatal("first Acquire should succeed")
	}
	if g.Acquire("k") {
		t.Error("second Acquire on same key should fail (busy)")
	}
	if !g.Acquire("other") {
		t.Error("Acquire on different key should succeed")
	}
	g.Release("k")
	if !g.Acquire("k") {
		t.Error("Acquire after Release should succeed")
	}
}

func TestGateReleaseIdempotent(t *testing.T) {
	g := spawn.NewGate()
	g.Acquire("k")
	g.Release("k")
	g.Release("k") // second release is a no-op, must not panic
	if g.IsBusy("k") {
		t.Error("IsBusy should be false after Release")
	}
}

func TestWithInFlightSerializesPerKey(t *testing.T) {
	g := spawn.NewGate()
	var hits int32
	var skipped int32
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, ok := spawn.WithInFlight(g, "shared", func() int {
				atomic.AddInt32(&hits, 1)
				return 0
			})
			if !ok {
				atomic.AddInt32(&skipped, 1)
			}
		}()
	}
	wg.Wait()
	// Each call holds the gate briefly; concurrent callers either get
	// the gate sequentially or are skipped with ok=false. Total must
	// equal the launch count.
	if int(hits+skipped) != 50 {
		t.Errorf("hits+skipped = %d, want 50", hits+skipped)
	}
	if hits == 0 {
		t.Error("expected at least one successful run")
	}
	// After the burst, the gate must be free for a fresh Acquire.
	if !g.Acquire("shared") {
		t.Error("gate not released after burst")
	}
}

func TestGatesRegistryReturnsSameHandle(t *testing.T) {
	a := spawn.Gates.For("kindA")
	b := spawn.Gates.For("kindA")
	if a != b {
		t.Error("Gates.For should return the same handle for the same kind")
	}
	c := spawn.Gates.For("kindB")
	if a == c {
		t.Error("different kinds should yield different handles")
	}
}

func TestComputeStalePatchRunningWithoutRegistry(t *testing.T) {
	stale, reason := spawn.ComputeStalePatch(spawn.StaleInput{
		Status:           "running",
		HasRegistryEntry: false,
	})
	if !stale {
		t.Error("running without registry entry should flip to stale")
	}
	if reason != "registry-miss" {
		t.Errorf("reason: got %q, want registry-miss", reason)
	}
}

func TestComputeStalePatchRunningButFresh(t *testing.T) {
	now := time.Now()
	stale, _ := spawn.ComputeStalePatch(spawn.StaleInput{
		Status:            "running",
		StartedAt:         now.Add(-1 * spawn.DefaultRunningStaleAfter / 2),
		HasRegistryEntry:  true,
		Now:               now,
		RunningStaleAfter: spawn.DefaultRunningStaleAfter,
	})
	if stale {
		t.Error("running for half the cutoff should NOT be stale")
	}
}

func TestComputeStalePatchQueuedTooLong(t *testing.T) {
	now := time.Now()
	stale, reason := spawn.ComputeStalePatch(spawn.StaleInput{
		Status:           "queued",
		MetaCreatedAt:    now.Add(-2 * spawn.DefaultQueuedStaleAfter),
		Now:              now,
		QueuedStaleAfter: spawn.DefaultQueuedStaleAfter,
	})
	if !stale {
		t.Error("queued past cutoff should flip to stale")
	}
	if reason != "queued-too-long" {
		t.Errorf("reason: got %q, want queued-too-long", reason)
	}
}

func TestComputeStalePatchUnrelatedStatus(t *testing.T) {
	stale, _ := spawn.ComputeStalePatch(spawn.StaleInput{Status: "done"})
	if stale {
		t.Error("status=done should never be stale")
	}
}
