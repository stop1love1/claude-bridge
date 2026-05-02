package contract

import (
	"net/http"
	"time"

	"github.com/stop1love1/claude-bridge/internal/api"
	"github.com/stop1love1/claude-bridge/internal/usage"
)

// Endpoint is a single contract-checked HTTP route. Name is the OpenAPI
// operationId (matches api/openapi.yaml) and doubles as the testdata
// subdirectory name. Setup is optional; nil means an empty fixture.
//
// One row in this registry == one golden file. Add a new endpoint by:
//  1. Append an entry below.
//  2. Run `cmd/contract record <name>` against Next at :7777 to seed
//     testdata/<name>/golden.json.
//  3. Run `make contract` to verify Go matches.
//
// Endpoints that need fixture state (writes to bridge.json,
// sessions/<id>/meta.json, etc.) carry a Setup func that mutates the
// Fixture before the request fires.
type Endpoint struct {
	Name     string
	Method   string
	Path     string
	RawQuery string
	Headers  http.Header
	Body     []byte
	Setup    func(*Fixture) error
}

// Endpoints is the registry consulted by Verify / VerifyAll. S04 ships
// the pilot only; subsequent sessions append rows as they port handlers.
var Endpoints = map[string]Endpoint{
	"listTasksMeta": {
		Name:   "listTasksMeta",
		Method: http.MethodGet,
		Path:   "/api/tasks/meta",
		// Setup: nil — empty sessions dir. Next returns `{}` in this
		// state (see app/api/tasks/meta/route.ts: readdirSync over an
		// empty SESSIONS_DIR yields no entries). Go pilot mirrors that.
	},
	"listAllSessions": {
		Name:   "listAllSessions",
		Method: http.MethodGet,
		Path:   "/api/sessions/all",
		// Setup: nil. The S05 stub in internal/api/sessions.go returns
		// [] unconditionally — the full implementation depends on
		// internal/meta + internal/git + internal/repos which land in
		// later sessions (S09/S15/S17). The golden was hand-authored
		// (not recorded against Next, since live Next state always
		// includes the bridge's own session dir under
		// ~/.claude/projects/) to capture the empty-state shape Next
		// would produce in a clean fixture: a JSON empty array.
		// When the full handler ports, re-record from a fresh Next
		// instance and update the Setup hook to seed deterministic
		// fixture state.
	},
	"getUsage": {
		Name:   "getUsage",
		Method: http.MethodGet,
		Path:   "/api/usage",
		Setup: func(f *Fixture) error {
			// Point the snapshot reader at an empty fixture root with
			// no stats-cache.json / .credentials.json — the handler
			// must produce the canonical "missing source" snapshot.
			// The frozen Now() makes Quota.FetchedAt deterministic so
			// the golden stays bytewise-stable across runs.
			r := &usage.Reader{
				Root:         f.UsageRoot,
				Now:          func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
				QuotaFetcher: usage.NotImplementedQuota{},
			}
			api.SetUsageReader(r)
			return nil
		},
	},
	"getTaskUsage": {
		Name:   "getTaskUsage",
		Method: http.MethodGet,
		Path:   "/api/tasks/t_20260101_001/usage",
		// S10 upgrade: handler now reads meta.json. With an empty
		// fixture (no task dirs) the response is still 404 —
		// `{"error":"task not found"}` — so the golden is unchanged
		// from S06.
	},
	"listTasks": {
		Name:   "listTasks",
		Method: http.MethodGet,
		Path:   "/api/tasks",
		// Empty fixture → empty array. Lands in S10.
	},
	"getTask": {
		Name:   "getTask",
		Method: http.MethodGet,
		Path:   "/api/tasks/t_20260101_001",
		// Empty fixture → 404 not-found.
	},
	"getTaskMeta": {
		Name:   "getTaskMeta",
		Method: http.MethodGet,
		Path:   "/api/tasks/t_20260101_001/meta",
		// Empty fixture → 404 not-found.
	},
	"getTaskSummary": {
		Name:   "getTaskSummary",
		Method: http.MethodGet,
		Path:   "/api/tasks/t_20260101_001/summary",
		// Empty fixture → 404 not-found.
	},
}
