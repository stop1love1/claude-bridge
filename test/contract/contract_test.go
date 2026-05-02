package contract_test

// Bridges the contract framework into `go test ./...` so `make test`
// catches parity regressions without depending on the standalone
// `make contract` target. Both entrypoints share the same Verify code
// path — the CLI just adds golden-recording on top.

import (
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/test/contract"
)

func TestContractAll(t *testing.T) {
	if len(contract.Endpoints) == 0 {
		t.Fatal("contract registry is empty — pilot endpoint should be present")
	}
	if _, ok := contract.Endpoints["listTasksMeta"]; !ok {
		t.Fatal("contract registry missing pilot endpoint listTasksMeta")
	}
	for name := range contract.Endpoints {
		name := name
		t.Run(name, func(t *testing.T) {
			diff, err := contract.Verify(name, ".")
			if err != nil {
				t.Fatalf("verify %s: %v", name, err)
			}
			if diff != "" {
				t.Fatalf("contract drift for %s:\n%s", name, indent(diff))
			}
		})
	}
}

func indent(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		lines[i] = "    " + l
	}
	return strings.Join(lines, "\n")
}
