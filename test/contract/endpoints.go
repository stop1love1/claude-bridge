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
}
