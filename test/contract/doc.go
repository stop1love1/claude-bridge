// Package contract is the parity test harness for the Next→Go migration.
//
// The framework's job is to prove every Go handler returns a response
// that is bytewise identical to its Next.js counterpart for the same
// fixture and request. Each endpoint owns a golden file under
// testdata/<operationId>/golden.json captured from Next, and `Verify`
// runs the in-process Go chi handler with the same fixture, normalizes
// transient headers (Date, X-Request-Id, Set-Cookie expiry), and diffs.
//
// The framework is dual-use:
//   - go test ./test/contract/...  ->  runs Verify for every endpoint
//     in the registry as part of `make test`.
//   - cmd/contract verify-all      ->  same checks, CLI entrypoint used
//     by `make contract` and CI.
//   - cmd/contract record <name>   ->  capture a fresh golden from Next
//     at http://localhost:7777 (dev-time only, requires Next running).
//
// See README.md for the per-endpoint workflow and the header ignore list.
package contract
