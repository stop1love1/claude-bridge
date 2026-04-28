# Claude Code — bridge repo conventions

You are running inside the **Claude Bridge** repo. Its job is to coordinate cross-repo work across sibling app folders (see the Repos table in `BRIDGE.md`).

## If the user asks you to work on a task

Tasks live in `sessions/<task-id>/meta.json`. The bridge UI at `http://localhost:7777` is the canonical interface — create, edit, and move tasks there. Each task has a stable ID `t_YYYYMMDD_NNN` (visible in the meta directory name and in the UI URL `/tasks/<id>`). Section transitions go through `PATCH /api/tasks/<id>` with `{"section": "..."}`. `tasks.md` is no longer read or written by the bridge — treat it as a stale notebook, not data.

### Task lifecycle (read this carefully)

- The coordinator moves a task `TODO → DOING` before spawning agents and `DOING → BLOCKED` if work cannot finish.
- The coordinator **never** moves a task to `DONE — not yet archived` itself. After all child agents succeed, the coordinator leaves the task in `DOING` and uses `READY FOR REVIEW` as the top line of `summary.md` so the user knows the work is shippable.
- The user confirms completion by ticking the checkbox on the task card in the UI — that PATCH (`{section: "DONE — not yet archived", checked: true}`) is the only path into the DONE column. Do not auto-tick on the user's behalf.

### Per-app git workflow (bridge-managed)

Each app entry in `bridge.json` carries optional `git` settings (`branchMode`, `fixedBranch`, `autoCommit`, `autoPush`). The bridge runs git on the operator's behalf:

- **Before** spawning a child in an app's working tree, the bridge honors `branchMode` (`current` = no-op, `fixed` = `git checkout <branch>` creating it from HEAD if missing, `auto-create` = `git checkout -b claude/<task-id>`).
- **After** a child run succeeds, the bridge optionally runs `git add -A && git commit && git push` per the app's `autoCommit` / `autoPush` flags.

A child agent must therefore **not** run `git checkout`, `git commit`, or `git push` itself — the bridge owns those. The child writes code and exits; the lifecycle hook handles the rest. (Failures are logged but never flip a successful run to `failed`.)

**Always self-register** when the user hands you a task — the bridge UI and future Claude sessions rely on this index:

```bash
# 1. Find your own session ID. Claude derives the project-dir slug from
#    the cwd by replacing /, \, :, and . with dashes (case follows the
#    cwd). The shell snippet below computes the slug for whatever the
#    current bridge path is — no hardcoded project name.
SLUG=$(pwd | sed 's#[\\/:.]#-#g')
ls -t ~/.claude/projects/${SLUG}/*.jsonl | head -1

# 2. POST to the bridge (idempotent, updates in place if already registered).
#    The `x-bridge-internal-token` header lets spawned children bypass the
#    web UI's auth middleware — it's already in the env as $BRIDGE_INTERNAL_TOKEN.
curl -s -X POST http://localhost:7777/api/tasks/<task-id>/link \
  -H "content-type: application/json" \
  -H "x-bridge-internal-token: $BRIDGE_INTERNAL_TOKEN" \
  -d "$(jq -n --arg sid '<uuid-from-step-1>' --arg repo "$(basename "$PWD")" \
    '{sessionId:$sid, role:"coordinator", repo:$repo, status:"running"}')"
```

The Next.js app (`bun dev`) runs from this same directory — `app/`, `lib/`, `package.json` all live at the bridge root.

Replace `role` with whatever label fits the work you're doing (`coordinator`, `coder`, `reviewer`, `planner`, `doc-writer`, …). The UI displays whatever you pick.

If the bridge UI isn't running, fall back to direct file write: read `sessions/<task-id>/meta.json`, append a run entry, write the whole file back. Same fields as the POST body, plus `startedAt` (ISO string) and `endedAt: null`.

Update `status` to `"done"` (or `"failed"`) and set `endedAt` when you finish.

## When spawning sub-agents

If the coordinator prompt in `bridge/coordinator.md` tells you to spawn sub-agents (coder/reviewer/…), each child `claude -p` process must also register itself — either have the child run the curl above, or do it yourself after capturing the child's session UUID from its stdout.

## What *not* to do

- Don't invent a new session format. Sessions are the plain `.jsonl` files Claude Code writes to `~/.claude/projects/<slug>/`.
- Don't hardcode absolute paths or repo names. The apps registry lives in `bridge.json` (committed to git), edited via the UI's "Add app" / "Auto-detect" buttons. The bridge folder itself is referenced via `basename "$PWD"`, never a hardcoded string.
- Don't edit files inside `../<other-repo>/` from here — spawn a child `claude` in that repo instead.
- Don't edit `bridge/tasks.md` to move tasks between sections. Use `PATCH /api/tasks/<id>` with `{"section": "TODO" | "DOING" | "BLOCKED" | "DONE — not yet archived", ...}` — the bridge writes the canonical state to `sessions/<id>/meta.json`.
- Don't run `git checkout` / `git commit` / `git push` from inside a child agent. The bridge runs those automatically per the app's settings — duplicating them races the lifecycle hook.
- Don't auto-PATCH a task to `DONE — not yet archived` from the coordinator. Completion is user-confirmed; auto-promoting bypasses the review gate.
- **Don't drop screenshots, scratch images, or downloaded binaries at the bridge root.** UI test screenshots (Playwright MCP, manual `browser_take_screenshot`, etc.) go in [`.playwright-mcp/`](.playwright-mcp/) — that path is already gitignored alongside the console-log files the MCP server writes there. Anything else throwaway (HAR captures, design refs, paste-ins) belongs in `.bridge-state/` or a task's `sessions/<task-id>/` folder, not the repo root. The root is reserved for source + config; loose `*.png` clutters `git status`, slips into commits via `git add .`, and bloats the workspace listing.
- **Don't dispatch work via Claude Code's built-in `Task` / `Agent` tool from the coordinator.** That tool spawns subagents in-process — they share the coordinator's cwd (`claude-bridge/`), bypass `meta.json`, and never reach the target app folder. The coordinator is launched with `--disallowed-tools Task` to hard-block this; if you find Task available anyway, don't use it. The only sanctioned dispatch path is `POST /api/tasks/<id>/agents`. Same rule for direct `claude -p` shell-outs and `cd ../<repo> && …` Bash calls — both escape the bridge's cwd / tracking / permission contract.

See `bridge/coordinator.md` for the full orchestration playbook.
