package contract

import "net/http"

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
}
