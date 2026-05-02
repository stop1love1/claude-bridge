package contract

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"sort"
	"testing"

	"github.com/rs/zerolog"

	"github.com/stop1love1/claude-bridge/internal/api"
	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/server"
)

// TestDumpGoldens prints the actual handler response for every endpoint
// in the registry. Skipped unless DUMP_GOLDENS=1 — used during S06 to
// seed hand-authored goldens for endpoints that can't be recorded
// against Next (state-non-deterministic, fixture-only behavior, etc.).
//
// Run with:
//   DUMP_GOLDENS=1 go test -run TestDumpGoldens -v ./test/contract/...
func TestDumpGoldens(t *testing.T) {
	if os.Getenv("DUMP_GOLDENS") != "1" {
		t.Skip("set DUMP_GOLDENS=1 to dump")
	}
	names := make([]string, 0, len(Endpoints))
	for n := range Endpoints {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		e := Endpoints[n]
		fix, err := NewFixture()
		if err != nil {
			t.Fatalf("fixture: %v", err)
		}
		api.SetConfig(&api.Config{
			SessionsDir:  fix.SessionsDir,
			ProjectsRoot: fix.ProjectsDir,
		})
		api.SetBridgeRoot(fix.Root)
		apps.SetDefault(apps.New(fix.Root))
		if e.Setup != nil {
			if err := e.Setup(fix); err != nil {
				t.Fatalf("setup %s: %v", n, err)
			}
		}
		h := server.NewHandler(server.Config{Logger: zerolog.New(io.Discard)})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(e.Method, e.Path, nil)
		h.ServeHTTP(rec, req)
		body := rec.Body.Bytes()
		fmt.Printf("==== %s ====\n", n)
		fmt.Printf("status:  %d\n", rec.Code)
		fmt.Printf("ct:      %q\n", rec.Header().Get("Content-Type"))
		fmt.Printf("body_b64: %s\n", base64.StdEncoding.EncodeToString(body))
		fmt.Printf("body:    %s\n", string(body))
		fmt.Println()
		_ = fix.Cleanup()
	}
}
