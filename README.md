# Claude Bridge

A cross-repo coordinator that runs Claude Code agents against multiple sibling app folders. The bridge is a thin Next.js dashboard plus a small set of markdown files (`BRIDGE.md`, `decisions.md`, `bugs.md`, `questions.md`, `schema.md`, `contracts/`) that hold whatever **cannot be derived** from any single app's source.

## How it works

- Drop the bridge folder next to your app repos (any number of siblings — the bridge auto-detects each one's stack via `package.json`, Prisma schema, top-level dirs, and `CLAUDE.md`).
- Declare the sibling folder names in `BRIDGE.md`'s **Repos** table.
- Create a task in the UI at `http://localhost:7777` (or POST it via the API).
- The bridge spawns a coordinator agent that picks the right repo(s), spawns child agents in those cwds, aggregates their reports back into `sessions/<task-id>/summary.md`.

No project name is hardcoded — the bridge folder's name, the repo names, and their roles are all derived at runtime.

## Quickstart

```bash
bun install
bun dev          # starts the UI on http://localhost:7777
```

Edit `BRIDGE.md` to point at your real sibling folder names, then create a task in the UI.
