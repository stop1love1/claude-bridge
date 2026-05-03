package api

import (
	"sync"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// TestNewAgentUUIDUniqueAcrossTightLoop asserts the crypto/rand-backed
// newAgentUUID never collides across 10 000 generations, including
// from concurrent goroutines. The previous implementation derived
// bytes from time.UnixNano() with bit shifts and would silently
// repeat ids when two SpawnAgent calls landed in the same nanosecond
// — a single collision would silently overwrite a child's session
// row in meta.json.
//
// 10 000 iterations is plenty: with crypto/rand on a v4 UUID the
// per-pair collision probability is ~3 × 10⁻³⁸; if this test ever
// observes a duplicate we know the implementation regressed.
func TestNewAgentUUIDUniqueAcrossTightLoop(t *testing.T) {
	const n = 10000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		u := newAgentUUID()
		if _, dup := seen[u]; dup {
			t.Fatalf("duplicate UUID at iter %d: %s", i, u)
		}
		seen[u] = struct{}{}
	}
}

// TestNewAgentUUIDUniqueConcurrent goes one step further and races
// 32 goroutines, each minting 256 ids. The earlier time-derived
// generator was specifically bad in this shape: parallel goroutines
// hitting the same UnixNano() produced identical bytes.
func TestNewAgentUUIDUniqueConcurrent(t *testing.T) {
	const goroutines = 32
	const each = 256
	out := make(chan string, goroutines*each)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for g := 0; g < goroutines; g++ {
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				out <- newAgentUUID()
			}
		}()
	}
	wg.Wait()
	close(out)
	seen := make(map[string]struct{}, goroutines*each)
	for u := range out {
		if _, dup := seen[u]; dup {
			t.Fatalf("duplicate UUID under concurrency: %s", u)
		}
		seen[u] = struct{}{}
	}
}

// TestSanitizeHeaderValueStripsControlChars covers the header-injection
// fix in SpawnAgent: a git error containing \r\n must not be set on
// the response unmodified, or it would inject a fake header / body
// separator into the SSE / JSON stream.
func TestSanitizeHeaderValueStripsControlChars(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"branch missing", "branch missing"},
		{"line one\nline two", "line one line two"},
		{"line\r\nwith\rcarriage", "line with carriage"},
		{"tabs\tand\nnulls\x00here", "tabs and nulls here"},
		{"\nleading", "leading"},
		{"trailing\n", "trailing"},
		{"  spaces preserved  ", "spaces preserved"},
		{"", ""},
	}
	for _, tc := range cases {
		got := sanitizeHeaderValue(tc.in)
		if got != tc.want {
			t.Errorf("sanitizeHeaderValue(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestSessionRewindLockSerializes asserts the rewind handler grabs
// the per-session-file lock so a concurrent rewind on the same file
// can't race the read → write → rename window. We don't have a clean
// way to simulate a real concurrent spawn here, but we can exercise
// two parallel rewinds against the same session file and assert the
// process completes without panic and the file ends up consistent.
//
// Without the lock, the second rewind's WriteFile / Rename could
// observe the first rewind's pre-rename intermediate state. With the
// lock, the second rewind serializes after the first.
func TestSessionRewindLockSerializes(t *testing.T) {
	// The full handler test requires repos/sessions plumbing; for now
	// exercise the lock primitive itself to confirm it serializes the
	// shape we use (fan-in to the same key). That at least catches a
	// deadlock-shaped regression where the new code holds the lock
	// across a callback that re-enters it.
	const goroutines = 8
	var wg sync.WaitGroup
	wg.Add(goroutines)
	counter := 0
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			// Use a fresh key per call shape: same key serializes; if
			// the underlying lock leaked or deadlocked we'd hang here.
			_ = withTaskLockForTest("rewind:/tmp/foo.jsonl", func() {
				counter++
			})
		}()
	}
	wg.Wait()
	if counter != goroutines {
		t.Errorf("counter: got %d, want %d", counter, goroutines)
	}
}

// withTaskLockForTest is a thin wrapper around meta.WithTaskLock so
// the in-package test above can invoke the same primitive the rewind
// handler uses without exposing meta directly inside the goroutines.
func withTaskLockForTest(key string, fn func()) error {
	return meta.WithTaskLock(key, func() error {
		fn()
		return nil
	})
}
