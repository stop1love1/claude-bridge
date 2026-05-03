# Claude Bridge

A coordinator for cross-repo Claude Code work. The bridge is a single Go binary
that serves an HTTP API plus a local SPA dashboard; you describe a task in plain
prose, the coordinator picks the right sibling repos, spawns child `claude`
processes in each, streams their output to the dashboard, and runs a verify
chain before declaring anything shippable. Sibling repos resolve as
`../<folder-name>` — there are no hardcoded paths.

> This repo is on the `migration/go` branch. The Go server has reached feature
> parity with the legacy TS/Bun/Next.js app for the core dispatch loop. The
> dashboard frontend is a Vite SPA under `web/`, embedded into the binary at
> build time.

## Quick start

Install the dev toolchain (air for Go reload, golangci-lint, oapi-codegen),
then run backend + frontend hot reload concurrently:

```
make tools
make dev
```

`make dev` runs `air` on the Go server and `pnpm dev` on the Vite SPA in
parallel. The backend defaults to `127.0.0.1:8080`; the SPA dev server proxies
`/api/*` to it.

## Build a single binary

```
make build              # vite build -> embed -> go build
./bin/bridge serve      # default 127.0.0.1:8080
./bin/bridge serve --port 7777
```

`make build` runs the Vite build (when `web/package.json` is present), embeds
the static assets via `embed.FS`, and produces `bin/bridge` (or
`bin/bridge.exe` on Windows). The output is a self-contained binary — no
`node_modules`, no separate frontend deploy.

## Authentication

The bridge uses a constant-time bearer token for the HTTP API. On first start
the server reads `BRIDGE_INTERNAL_TOKEN` from the environment; if unset, it
generates a 32-byte hex token and prints it once on stderr:

```
{"level":"info","token":"<hex>","message":"generated BRIDGE_INTERNAL_TOKEN —
  set this in your shell to keep it stable across restarts"}
```

Copy that line into your shell so the same token survives restarts. Spawned
child `claude` processes inherit it automatically.

For trusted single-machine setups you can skip auth for loopback callers with
`--localhost-only`. Don't enable that on a shared host.

## CLI flags

`bridge serve` takes:

| Flag | Default | Notes |
|---|---|---|
| `--port` | `8080` | TCP port to bind. |
| `--host` | `127.0.0.1` | Interface to bind. |
| `--root` | cwd | Bridge root (where `bridge.json`, `sessions/`, `prompts/` live). |
| `--allowed-origin` | `http://localhost:7777` | CORS origin permitted to call the API; repeatable; wildcards rejected. |
| `--localhost-only` | `false` | Bypass auth for `127.0.0.1` / `::1` callers. Single-machine trust only. |

## Project layout

```
cmd/bridge/             # binary entrypoint (cobra)
cmd/contract/           # OpenAPI contract verifier
internal/api/           # HTTP handlers, split per OpenAPI op
internal/api/genapi/    # generated OpenAPI server interface
internal/auth/          # constant-time token compare + generation
internal/middleware/    # chi auth middleware
internal/server/        # router + middleware wiring
internal/spawn/         # claude child-process registry + reaper
internal/coordinator/   # coordinator orchestration
internal/runlifecycle/  # post-spawn verify + git AfterSpawn
internal/retry/         # role-suffix retry ladder
internal/meta/          # sessions/<id>/meta.json store + lock
internal/sessions/      # JSONL transcript reader
internal/usage/         # token usage aggregation
internal/git/           # branch ops + worktrees
internal/apps/          # bridge.json registry + repo resolution
internal/detect/        # task-scope auto-detection
internal/memory/        # CLAUDE.md / per-app memory
internal/permission/    # interactive permission prompt store
internal/pathsafe/      # symlink-aware containment helper
internal/quality/       # house rules + style fingerprints
internal/symbol/        # symbol index
internal/slash/         # /slash command discovery
internal/upload/        # file upload guards
internal/tunnels/       # ngrok / localtunnel manager
internal/childprompt/   # child claude system-prompt builder
web/                    # Vite SPA frontend
prompts/                # coordinator + role prompts
test/contract/          # OpenAPI golden contract suite
test/fixtures/fake-claude  # test stub for the claude binary
api/openapi.yaml        # source of truth for the HTTP API
```

## Testing

```
make test               # go test ./...
make contract           # OpenAPI contract verifier (record/replay)
make lint               # golangci-lint run ./...
```

On Windows, run tests serialized with `go test -p=1 ./...` — some packages
spawn child processes that race when the test binary parallelizes packages.

## Where things live

- **Tasks** — `sessions/<task-id>/meta.json` is canonical. The dashboard
  PATCHes it through `/api/tasks/<id>`. `tasks.md` is no longer read or
  written by the bridge.
- **Apps registry** — `bridge.json` at repo root. Edit via the UI's
  "Add app" / "Auto-detect" buttons or by hand.
- **Bridge state** — runtime caches and locks under `.bridge-state/` (created
  on demand).
- **Cross-repo conventions** — see `BRIDGE.md` (cross-repo coordination
  contract) and `CLAUDE.md` (Claude Code agent rules).
- **Coordinator playbook** — `prompts/coordinator.md`.

## Migration note

This repo migrated from TS/Bun/Next.js to a Go single-binary in early 2026.
Session-by-session migration logs are archived under
[`docs/archive/`](docs/archive/README.md).
