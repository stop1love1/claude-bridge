# Contract test framework

Bytewise parity harness for the **Next.js → Go migration** (`migration/go`
branch). Every Go handler in `internal/api/*` ships with a *golden file*
recorded against the live Next dev server, and this framework asserts
that the Go response matches the golden after a small set of normalizers
have been applied.

The same code path runs from two entrypoints:

| Entrypoint                               | Used by                | Notes                                                          |
| ---------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `go test ./test/contract/...`            | `make test`, CI        | Verify-only. Runs every endpoint in the registry.              |
| `go run ./cmd/contract verify-all`       | `make contract`, CI    | Same checks, plain text report. Exit 1 on any drift.           |
| `go run ./cmd/contract verify <name>`    | local debug            | Verify one endpoint.                                           |
| `go run ./cmd/contract record <name>`    | seeding new goldens    | **Requires Next at `:7777`.** Captures full HTTP response.     |

---

## Adding a new endpoint

1. Append a row to `Endpoints` in [`endpoints.go`](endpoints.go).
2. Implement (or stub) the Go handler under `internal/api/`.
3. With the Next dev server running locally:
   ```bash
   bun dev                                            # in one terminal
   go run ./cmd/contract record <operationId>         # in another
   ```
   This writes `testdata/<operationId>/golden.json`.
4. Run `make contract` (or `go test ./test/contract/...`) — Go in-process
   handler is exercised and diffed against the golden.
5. Commit the registry row, the golden, and the Go handler in the same
   PR. Reviewer §6.9 checks that every modified handler has a passing
   golden.

For endpoints that need fixture state (existing tasks, sessions on
disk, a populated `bridge.json`), set the `Setup` field on the
`Endpoint` row. The fixture API in [`seed.go`](seed.go) writes to a
fresh tempdir per Verify call.

---

## Header normalization

Some response headers vary every request and would never produce a
stable golden. They are **stripped from both golden and actual** before
diffing, by the normalizers in [`replay.go`](replay.go):

| Header             | Why it's stripped                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Date`             | Wall-clock timestamp, changes every request.                                                                      |
| `X-Request-Id`     | Random 12-byte id added by `hlog.RequestIDHandler` (Go) / equivalent middleware on Next.                          |
| `Vary: Origin`     | Added unconditionally by `go-chi/cors` even on non-Origin requests; Next routes don't emit it for the same calls. |
| `Set-Cookie` expiry| The `Expires=...` attribute carries a wall-clock epoch; the rest of the cookie (path, samesite, …) is still diffed. |

**Anything else is fair game for diff.** If a future endpoint legitimately
emits a transient header that isn't in this list, decide between:

- **Strip it** — add a normalizer to `DefaultNormalizers` in `replay.go`
  AND document it here. Use only for true server-side artifacts.
- **Pin it** — make the handler deterministic so the golden matches
  bytewise. Always preferred when the value is meaningful (Cache-Control,
  Content-Type, Set-Cookie name/path/SameSite/Secure/HttpOnly).

Body normalization is **not allowed** — JSON shape drift, key ordering,
and trailing-newline quirks (`json.NewEncoder` adds `\n`, Next's
`NextResponse.json` doesn't) are real parity bugs and the framework
catches them. Use `internal/api.WriteJSON` from every Go handler so the
no-newline framing stays consistent.

---

## SSE & streaming endpoints

Spec from `MIGRATION_GO.md §6.8`: record only the **first 5 events** of a
stream then stop. The current framework doesn't yet have SSE plumbing —
it lands when the first SSE handler ports (S12, `GET /api/tasks/:id/events`).
Until then `record` issues a synchronous request and reads the body to
EOF, which would hang on an SSE source — don't try to record SSE
endpoints with the current CLI.

## Multipart upload

Spec: include hash of the file payload, not raw bytes. Lands with S27
(`POST /api/sessions/:id/upload`).

---

## Golden file format

```json
{
  "status": 200,
  "headers": { "Content-Type": ["application/json; charset=utf-8"] },
  "body_base64": "e30=",
  "body_text": "{}"
}
```

- `body_base64` is the canonical body. The loader reconstructs bytes
  from this field only.
- `body_text` is a UTF-8 mirror written when the body is valid UTF-8,
  purely so reviewers can read the response in code review without
  base64-decoding. It's ignored on load.
- Headers are written in sorted key order so diffs are stable.

---

## CI integration

`make contract` runs in CI alongside `make test` (`.github/workflows/go.yml`)
on Linux, macOS, and Windows. CI does **not** start Next — goldens are
committed to the repo. If a PR adds a new endpoint without a golden,
`verify-all` exits 1 and CI blocks.
