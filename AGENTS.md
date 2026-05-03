# Agents entering this repo

This repo's primary contract for an autonomous coding agent (Claude Code or
similar) lives in `CLAUDE.md`. Read that first — it covers task lifecycle,
self-registration, the per-app git workflow the bridge owns, and the rules
about not spawning sub-agents through the in-process `Task` tool.

This file is intentionally short. Pointers:

- `CLAUDE.md` — project conventions, task lifecycle, self-registration.
- `BRIDGE.md` — cross-repo coordination contract.
- `README.md` — build, run, and test the Go server + Vite SPA.
- `prompts/coordinator.md` — full orchestration playbook.

## Testing convention

Run the Go test suite with package parallelism disabled on Windows:

```
go test -p=1 ./...
```

Some packages spawn `claude` child processes; package-level parallelism races
the registry and the OS process table.
