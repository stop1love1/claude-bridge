// Command contract is the CLI driver for the parity test harness in
// test/contract. It exposes three subcommands:
//
//	contract record <name>   capture golden from a baseline (default
//	                         http://localhost:7777, the Next dev server).
//	contract verify <name>   run Go in-process and diff against golden.
//	contract verify-all      verify every endpoint in the registry.
//
// `make contract` invokes `verify-all`. The CLI lives outside test/
// because it ships in dev tooling — `go run ./cmd/contract …` works
// from the repo root without pulling in test/* into a release build.
package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/stop1love1/claude-bridge/test/contract"
)

func main() {
	if err := newRoot().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "contract",
		Short:         "Bytewise parity checks for the Next→Go migration",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(newRecordCmd(), newVerifyCmd(), newVerifyAllCmd())
	return root
}

func newRecordCmd() *cobra.Command {
	var baseline string
	cmd := &cobra.Command{
		Use:   "record <name>",
		Short: "Capture a fresh golden from the baseline server",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			e, ok := contract.Endpoints[name]
			if !ok {
				return fmt.Errorf("unknown endpoint %q", name)
			}
			req, err := contract.BuildRequest(baseline, e)
			if err != nil {
				return err
			}
			client := &http.Client{Timeout: 10 * time.Second}
			cap, err := contract.RecordAgainst(client, req)
			if err != nil {
				return fmt.Errorf("record %s: %w", name, err)
			}
			path := filepath.Join(testdataRoot(), contract.GoldenPath(name))
			if err := contract.WriteGolden(path, cap); err != nil {
				return fmt.Errorf("write golden: %w", err)
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "wrote %s (status=%d, %d bytes)\n", path, cap.Status, len(cap.Body))
			return nil
		},
	}
	cmd.Flags().StringVar(&baseline, "baseline", "http://localhost:7777", "Baseline server to record against")
	return cmd
}

func newVerifyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "verify <name>",
		Short: "Run Go in-process and diff against the recorded golden",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			diff, err := contract.Verify(name, testdataRoot())
			if err != nil {
				return err
			}
			if diff != "" {
				_, _ = fmt.Fprintf(cmd.OutOrStdout(), "[FAIL] %s\n%s\n", name, diff)
				return fmt.Errorf("contract drift for %s", name)
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "[ OK ] %s\n", name)
			return nil
		},
	}
}

func newVerifyAllCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "verify-all",
		Short: "Verify every endpoint in the contract registry",
		RunE: func(cmd *cobra.Command, args []string) error {
			report, err := contract.VerifyAll(testdataRoot())
			_, _ = fmt.Fprint(cmd.OutOrStdout(), report)
			return err
		},
	}
}

// testdataRoot resolves the absolute path to test/contract regardless
// of where the binary was launched from. We compile the location of
// this source file via runtime.Caller and walk to the sibling test/
// directory; this keeps `go run ./cmd/contract …` working from the
// repo root without forcing callers into the right cwd.
func testdataRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "."
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "test", "contract")
}
