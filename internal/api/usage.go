package api

import (
	"net/http"
	"sync"

	"github.com/stop1love1/claude-bridge/internal/usage"
)

// usageReader is the package-global usage.Reader. Initialized lazily so
// the snapshot reader's quota fetcher (and its TTL clock) is shared
// across HTTP requests — concurrent /api/usage polls share the cache
// rather than fanning out duplicate quota fetches.
//
// Tests that need to drive the reader (HTTP fixtures, contract checks
// with custom Root/QuotaFetcher) call SetUsageReader to inject one.
var (
	usageReaderMu sync.Mutex
	usageReader   *usage.Reader
)

// SetUsageReader installs a custom *usage.Reader. The contract test
// fixture uses this to point the snapshot at an empty fixture root so
// the response is deterministic. Production code never calls this.
func SetUsageReader(r *usage.Reader) {
	usageReaderMu.Lock()
	defer usageReaderMu.Unlock()
	usageReader = r
}

func getUsageReader() *usage.Reader {
	usageReaderMu.Lock()
	defer usageReaderMu.Unlock()
	if usageReader == nil {
		usageReader = usage.New()
	}
	return usageReader
}

// GetUsage is the Go side of GET /api/usage[?force=1]. Returns the
// local stats-cache snapshot + plan + quota. The quota fetcher in S06
// is stubbed (NotImplementedQuota) — full Anthropic OAuth fetch lands
// when auth/credentials wiring ports.
func GetUsage(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("force") == "1"
	snap := getUsageReader().Read(force)
	WriteJSON(w, http.StatusOK, snap)
}

// GetTaskUsage moved to tasks.go in S10 — full impl now reads meta.json
// and sums per-run usage. Per-run rows still return zeros until repos
// (S17) lets us resolve a run's repo back to its absolute cwd.
