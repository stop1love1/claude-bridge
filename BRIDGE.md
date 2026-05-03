# Claude Bridge — Cross-repo Coordinator

This project plays the role of **owner / coordinator** for a multi-repo system. It does not contain app code — it breaks work into tasks, decides per task which repo(s) to touch and how big an agent team to spawn, and keeps cross-repo context in sync.

Each app owns its own internal context (stack, architecture, conventions) in its own repo. The bridge only holds what **cannot be derived** from either app alone.

The bridge is **optional**. If a sibling app's own CLAUDE.md guard checks for the bridge folder, it can detect its absence and skip bridge logic entirely — nothing breaks.

For installation, scripts, and runtime options, see [README.md](README.md). This file is the cross-repo coordination playbook.

## Apps

The apps roster lives in `~/.claude/bridge.json` (per-machine, edited via the bridge UI). Every entry has a folder name, a path, an optional description, and an optional `git` block: branch policy (`current` / `fixed` / `auto-create` / worktree-isolated) + auto-commit / auto-push + post-success integration (`auto-merge` into a target branch, or `pull-request` via a `devops` child that drives `gh` / `glab`).

- **Add** apps via the bridge UI: `/apps` → "Add app" or "Auto-detect".
- **Edit** name, description, and git workflow per app via the gear icon.
- The coordinator dispatches tasks to whichever app the heuristic picks (or whichever the user pinned in the New Task dialog). The bridge's lifecycle hook then handles branch prep before the spawn, commit/push after a clean exit, and (when the app opts in) the post-success merge or PR/MR — all driven by the app's git settings, no coordinator action needed.

This file does **not** declare apps — it's purely the cross-repo notebook.

## When to read the bridge

Before starting any task with **cross-repo signals**:

- Touches an API (calling a new endpoint, changing request/response shape)
- The user mentions another repo ("repo-A returns the wrong field X", "repo-B needs endpoint Y")
- The user says "integrate", "connect", "sync" between repos

→ Read `prompts/decisions.md` first (recent decisions that may affect this work), then any other notebook the task body references.

## When to write to the bridge

After finishing a cross-repo task:

| Situation | Write to |
|---|---|
| Just shipped a new endpoint or changed an API shape | Create a follow-up task for the consumer repo via the UI |
| Just locked in a decision that isn't obvious from the code (naming, format, pagination style…) | `prompts/decisions.md` (append, dated) |
| Need to ask another repo something before continuing | `prompts/questions.md` (OPEN section) |
| Found a bug whose root cause is in another repo | `prompts/bugs.md` (OPEN section) |

## Task lifecycle

- **Coordinator** moves a task `TODO → DOING` before spawning agents and `DOING → BLOCKED` if work cannot finish.
- **Coordinator never auto-promotes to DONE.** Successful tasks stay in `DOING` with a `READY FOR REVIEW` summary.
- **User** confirms completion by ticking the task card's checkbox in the UI — that PATCH is the only path into `DONE — not yet archived`.

## File map

| File | Purpose | Who writes | Frequency |
|---|---|---|---|
| `BRIDGE.md` | This playbook | Bridge maintainers | very low |
| `prompts/coordinator.md` | Coordinator prompt template | Bridge maintainers | very low |
| `prompts/report-template.md` | Child agent report contract (canonical copy; `internal/childprompt` injects it into every child) | Bridge maintainers | very low |
| `prompts/playbooks/<role>.md` | Per-role playbook (style-critic, semantic-verifier, ui-tester, devops, …). Auto-injected into a child whose role matches the file's basename. | Bridge maintainers | low |
| `prompts/tasks.md` | Legacy notebook — runtime state lives in `sessions/<id>/meta.json` | (none — bridge writes meta.json) | n/a |
| `prompts/decisions.md` | Decisions log (append-only, dated) | Any repo | low |
| `prompts/questions.md` | Open questions between repos | Repo that asks | low |
| `prompts/bugs.md` | Cross-repo bugs | Repo that finds the bug | low |
| `~/.claude/bridge.json` | Apps registry + per-app git workflow settings. Outside the project tree so a `git pull` on the bridge never overwrites it. Edited via the bridge UI. | Bridge UI | low |

## Conventions

- **Plain markdown** — no JSON / YAML, so both humans and AI can read it.
- **Always date entries** with `YYYY-MM-DD`.
- **`prompts/decisions.md` is append-only.** To reverse an old decision, write a new entry that references the old one (`Supersedes: #YYYY-MM-DD-slug`).
- **Cross-link.** Link tasks → questions / decisions, using relative paths.
- **Don't dump everything.** The bridge holds only what **cannot be derived** from the source code or git history of any repo.
