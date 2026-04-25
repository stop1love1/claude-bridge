# Claude Code — bridge repo conventions

You are running inside the **Claude Bridge** repo. Its job is to coordinate cross-repo work across sibling app folders (see the Repos table in `BRIDGE.md`).

## If the user asks you to work on a task

Tasks live in `sessions/<task-id>/meta.json`. The bridge UI at `http://localhost:7777` is the canonical interface — create, edit, and move tasks there. Each task has a stable ID `t_YYYYMMDD_NNN` (visible in the meta directory name and in the UI URL `/tasks/<id>`). Section transitions (`TODO → DOING → DONE — not yet archived → BLOCKED`) go through `PATCH /api/tasks/<id>` with `{"section": "..."}`. `tasks.md` is no longer read or written by the bridge — treat it as a stale notebook, not data.

**Always self-register** when the user hands you a task — the bridge UI and future Claude sessions rely on this index:

```bash
# 1. Find your own session ID. Claude derives the project-dir slug from
#    the cwd by replacing /, \, :, and . with dashes (case follows the
#    cwd). The shell snippet below computes the slug for whatever the
#    current bridge path is — no hardcoded project name.
SLUG=$(pwd | sed 's#[\\/:.]#-#g')
ls -t ~/.claude/projects/${SLUG}/*.jsonl | head -1

# 2. POST to the bridge (idempotent, updates in place if already registered)
curl -s -X POST http://localhost:7777/api/tasks/<task-id>/link \
  -H "content-type: application/json" \
  -d "$(jq -n --arg sid '<uuid-from-step-1>' --arg repo "$(basename "$PWD")" \
    '{sessionId:$sid, role:"coordinator", repo:$repo, status:"running"}')"
```

The Next.js app (`bun dev`) runs from this same directory — `app/`, `lib/`, `package.json` all live at the bridge root.

Replace `role` with whatever label fits the work you're doing (`coordinator`, `coder`, `reviewer`, `planner`, `doc-writer`, …). The UI displays whatever you pick.

If the bridge UI isn't running, fall back to direct file write: read `sessions/<task-id>/meta.json`, append a run entry, write the whole file back. Same fields as the POST body, plus `startedAt` (ISO string) and `endedAt: null`.

Update `status` to `"done"` (or `"failed"`) and set `endedAt` when you finish.

## When spawning sub-agents

If the coordinator prompt in `agents/coordinator.md` tells you to spawn sub-agents (coder/reviewer/…), each child `claude -p` process must also register itself — either have the child run the curl above, or do it yourself after capturing the child's session UUID from its stdout.

## What *not* to do

- Don't invent a new session format. Sessions are the plain `.jsonl` files Claude Code writes to `~/.claude/projects/<slug>/`.
- Don't hardcode absolute paths or repo names. Sibling repos are resolved as `../<folder-name>` where `<folder-name>` comes from `BRIDGE.md`. The bridge folder itself is referenced via `basename "$PWD"`, never a hardcoded string.
- Don't edit files inside `../<other-repo>/` from here — spawn a child `claude` in that repo instead.
- Don't edit `tasks.md` to move tasks between sections. Use `PATCH /api/tasks/<id>` with `{"section": "TODO" | "DOING" | "BLOCKED" | "DONE — not yet archived", ...}` — the bridge writes the canonical state to `sessions/<id>/meta.json`.

See `agents/coordinator.md` for the full orchestration playbook.
