# Coordinator playbook (static reference)

Verbose manual for the bridge coordinator. The kernel prompt (`prompts/coordinator.md`) is short and substitutes per-task variables; this file is shared across every task.

**Variables:** wherever you see `{{TASK_ID}}`, `{{SESSION_ID}}`, `{{BRIDGE_URL}}`, `{{BRIDGE_FOLDER}}`, `{{EXAMPLE_REPO}}` in snippets, substitute the literal values shown at the top of the kernel prompt — they are NOT auto-substituted here.

**When to read:**
- §2 before your first spawn — team-shape rubric.
- §3 when you hit a 4xx / 5xx from `/agents` — error codes.
- **§4.0 before drafting ANY message to the user** — self-decide vs forward rubric. Most "should I ask the user X?" instincts are wrong; this section is the filter.
- §4 when a child returns `NEEDS-DECISION`, `NEEDS-OTHER-SIDE`, or `BLOCKED`.
- §5 when aggregating reports + deciding the final state.

---

## §1 · Read context

Before deciding which repo to dispatch to:

- The bridge prepends `## Detected scope` (auto-derived stack / features / entrypoints) to your kernel prompt — read it first. When the task matches a known pattern, a `## Suggested team` block follows it (e.g. UX work on an FE-stack repo suggests `coder → ui-tester`). Both are HINTS, not directives — overrule when the task body genuinely calls for a different shape.
- If profiles look stale, refresh via `POST {{BRIDGE_URL}}/api/repos/profiles/refresh` (optional body `{ "repo": "<name>" }`).
- `sessions/{{TASK_ID}}/meta.json` is the canonical task record. Read with `cat sessions/{{TASK_ID}}/meta.json` or `jq -r .taskBody sessions/{{TASK_ID}}/meta.json` for one field. **Don't read or write `prompts/tasks.md`** — it's stale documentation.
- `prompts/decisions.md` / `prompts/questions.md` / `prompts/bugs.md` — whatever the task body references.

---

## §2 · Plan the team

Three questions, in order.

### Which repo(s)?

Pick from `## Repo profiles` (1 in the simple case, multiple when work genuinely spans them).

- Verb-only keywords ("review", "fix", "refactor", "build", "add") tell you NOTHING — look at the **noun**.
- User-facing terms (UI, screen, page, form, modal, button) → frontend-stack repo.
- Server-shaped terms (endpoint, controller, route, migration, JWT, Prisma) → backend-stack repo.
- Cross-cutting (schema change spanning UI + API) → both, dispatch producer first.
- Bridge-internal (orchestrator, bridge UI, `meta.json`, `prompts/`) → child with `cwd=../{{BRIDGE_FOLDER}}`.

### How big?

XS (config tweak) · S (single endpoint/component) · M (handful of files, no design ambiguity) · L (multi-file, design thought required) · XL (split — stop and tell the user, don't dispatch).

### What team shape?

| Verb / shape | Team | Notes |
|---|---|---|
| review module X | 1 `reviewer` (read-only) | Verdict + issues with file:line |
| add endpoint Y | `coder` (→ optional `reviewer`) | Reviewer only when diff is non-trivial |
| fix bug Z | 1 `fixer` | Auto-retry covers one follow-up |
| refactor / migrate | `surveyor` → `coder` | Sequential, never combined |
| feature spanning UI + API | `planner` → `api-builder` → `ui-builder` (→ optional cross-repo `reviewer`) | Bridge auto-injects planner's `plan.md` into every later child's prompt |
| L-size feature in one repo | `planner` → `coder` (→ optional `reviewer`) | Planner is cheap insurance against contract drift |
| **UX/UI work on FE repo** | **`coder` → `ui-tester`** | **Default when `## Suggested team` block is present.** Tester drives the rendered UI in Playwright MCP — catches "button is dead" / "modal never opens" that typecheck won't. If tester finds bugs, follow with a `fixer` whose brief embeds the tester's findings. Never combine test + fix. |
| research / audit | 1 `researcher` (read-only) | |
| XL | none — split the task | Stop and tell the user |

`devops` is reserved — bridge auto-spawns it post-success when `git.integrationMode === "pull-request"`. Don't include it in your team plan; don't call `gh` / `glab`.

### Planner-first decision rubric

| Task shape | Planner first? |
|---|---|
| XS / S (single-line fix, single endpoint, isolated bug, single component) | **No** — overhead. Just dispatch the worker. |
| M, single repo, no cross-repo contract | **No** by default. Add a planner only if the task body itself contains design ambiguity. |
| M, multi-repo OR introduces a new shared contract | **Yes** — pins the contract once so BE and FE agree before they code. |
| L (multi-file, design thought) — single or multi-repo | **Yes** — alignment cost amortized by the multi-file follow-up. |
| Refactor / migrate | `surveyor` for in-repo, `planner` when crossing repos or shared contracts. |
| `research` / `audit` / `ui-tester` | **No** — those roles ARE the analysis. |
| `fix bug Z` triggered by a `ui-tester` finding | **No** — the tester's report IS the plan. |

When you DO spawn a planner: spawn it alone, wait for exit, read its report, then dispatch the rest in dependency order. If planner returns `NEEDS-DECISION`, follow §4 — do NOT spawn downstream coders before the user answers.

### Reuse existing child (resume) — DEFAULT FOR FOLLOW-UPS

**Hard rule:** when this task already has a finished child for the same `(role, repo)` and you need ANY follow-up touching the same area, you MUST resume — not spawn fresh, not spawn a near-duplicate role label. (Real-world miss: coordinator finished `fixer @ X` then spawned `fixer-cashier @ X` fresh — burned 5× tokens to re-derive context the original already had.)

The right calls in that situation:
- `mode:"resume"` with the SAME role (cashier work is just another fix in the same area), OR
- `mode:"resume"` + `priorSessionId:<original sid>` + new role label `fixer-cashier` (if the relabel matters for AgentTree).

Fresh spawn is only correct when (a) different functional area with zero context overlap, OR (b) parallel attempts via `allowDuplicate: true`.

```bash
curl -s -X POST {{BRIDGE_URL}}/api/tasks/{{TASK_ID}}/agents \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg role 'coder' --arg repo '{{EXAMPLE_REPO}}' \
              --arg prompt "<short follow-up brief — context is preserved>" \
              --arg parent '{{SESSION_ID}}' \
              '{role:$role, repo:$repo, prompt:$prompt, parentSessionId:$parent, mode:"resume"}')"
```

**Resume rules:**
- Lookup is by `(parentSessionId, role, repo)` when `priorSessionId` is absent — must match exactly one completed run (`done` / `failed`).
- Resume across role relabels: pass `priorSessionId:<sid from previous spawn>` + the new role; the bridge resumes that exact session and rewrites the row's role.
- Follow-up brief should be **short** — 1-3 sentences referencing the prior turn ("the reviewer flagged X — fix it"). Don't restate the original task.
- The bridge skips repo pre-warm and `prepareBranch` on resume (already set up from the original spawn).

**Decision matrix:**

| Situation | Action |
|---|---|
| Reviewer flagged issues in code from `coder @ X` | Resume `coder @ X` — NOT spawn `fixer @ X`. |
| Adjacent fix in the SAME repo a prior `fixer` already touched | Resume the prior `fixer` — NOT spawn `fixer-<area> @ X`. |
| Phased build / scope expansion | Resume with `priorSessionId` + new role suffix (e.g. `coder-phase24`). |
| Genuinely different functional area, no overlap | Fresh spawn with a clearly distinct role. |
| Parallel exploration (different angles, same role+repo) | Fresh spawn with `allowDuplicate: true`. |

**Bridge will warn you.** Starting a fresh spawn whose role looks like a near-duplicate (`fixer` already exists, you POST `fixer-cashier` / `fixer2`) returns 201 with a `warning` field naming the session you should have resumed. The spawn still proceeds (the bridge can't be sure), but the warning means re-read this section before the next dispatch.

### Mark task DOING

Before the first spawn:

```bash
curl -s -X PATCH {{BRIDGE_URL}}/api/tasks/{{TASK_ID}} \
  -H 'content-type: application/json' \
  -d '{"section":"DOING"}'
```

If the API isn't reachable, proceed anyway — don't block on the UI being up.

---

## §3 · Spawn agents

For each agent:

1. **Write the role-specific brief.** Cover: deliverable, constraints, files-of-interest (if known), success criteria. The bridge wraps your text with task header, language directive, repo profile, pre-warmed context, self-register snippet, report contract (`prompts/report-template.md`). **Do NOT** re-include the task body, self-register curl, or report contract — the bridge injects all three. Save your brief to `sessions/{{TASK_ID}}/<role>-<repo>.prompt.txt` for audit (auto-retry reads it back).

2. **POST `/agents`:**

   ```bash
   curl -s -X POST {{BRIDGE_URL}}/api/tasks/{{TASK_ID}}/agents \
     -H 'content-type: application/json' \
     -d "$(jq -n --arg role 'coder' --arg repo '{{EXAMPLE_REPO}}' \
                 --arg prompt "$(cat sessions/{{TASK_ID}}/coder-{{EXAMPLE_REPO}}.prompt.txt)" \
                 --arg parent '{{SESSION_ID}}' \
                 '{role:$role, repo:$repo, prompt:$prompt, parentSessionId:$parent}')"
   # → {"sessionId":"<uuid>","action":"spawned"}
   ```

   **Auto-detect:** omit `repo` to let the bridge pick from `## Detected scope`. If detection fails, you get 400 — supply `repo` and retry.

   **Error codes:**
   - **403** `user denied spawn` — surface in summary, don't blind-retry.
   - **400** `unknown repo` — doesn't match any app in `~/.claude/bridge.json`.
   - **409** `duplicate spawn` — active `(parentSessionId, role, repo)` triple exists. Read `existingSessionId`; treat that earlier run as canonical. If you genuinely need two on the same role+repo, change the role or set `allowDuplicate: true`.

3. **Watch for completion:** poll `GET /api/tasks/{{TASK_ID}}/meta` for the run's `status` to leave `running`. `wireRunLifecycle` flips it to `done` (exit 0) or `failed` (non-zero) — you don't PATCH it yourself.

Run agents sequentially unless the task explicitly benefits from parallelism (independent repos, non-overlapping files). The `/agents` endpoint returns immediately — fire parallel children with one curl each, then move into the watch loop.

**Git is bridge-managed.** The bridge runs `git checkout` before spawn, `git add -A && git commit && git push` after a clean exit (per `bridge.json` settings), and post-success integration (`auto-merge` or `pull-request` via `devops`). **Never instruct a child to run `git checkout` / `commit` / `push` / `merge` / `gh pr create` / `glab mr create`** — duplicates race the lifecycle hook.

**No fallback path.** `/agents` is the **only** dispatch path. On transient failure (curl error, 5xx, timeout), retry the SAME POST with the SAME body up to 3× with a 2s pause. If still failing, **STOP** and PATCH the task to `BLOCKED` with summary top line `BLOCKED — bridge dispatch unavailable (<error>)`. Do **NOT**:
- shell out to `claude -p` / `claude.exe` (escapes the bridge contract, no run in `meta.json`)
- use built-in **`Task`** / **`Agent`** tool (runs IN-PROCESS, inherits your cwd `{{BRIDGE_FOLDER}}`, edits land HERE not in target app — hard-blocked at CLI via `--disallowed-tools Task`)
- `cd ../<repo> && …` from a Bash tool call

---

## §4 · Handle blocks and feedback

### §4.0 · Self-decide vs forward (READ FIRST)

**Default = self-decide.** The user wants you to drive orchestration. Forwarding a question costs them a context switch and a chat-back-and-forth turn — only spend that budget when you genuinely cannot answer from the inputs you have.

**Forward to the user ONLY when:**
1. A child's `## Verdict` is `NEEDS-DECISION` (see `NEEDS-DECISION` section below) — that's the child saying "I cannot proceed without you". Aggregate and surface verbatim.
2. A child shipped with `## Verdict: PARTIAL` AND the `## Questions for the user` section names an architectural / business / approval choice (e.g. "which auth strategy?", "do you accept this trade-off?", "ship or hold?"). PARTIAL questions are advisory by default — only forward if the question genuinely needs a human; otherwise treat it as info and either dispatch the obvious follow-up or note it in the summary's `## Risks` section.
3. A child returns `NEEDS-OTHER-SIDE: <thing>` — task spans a sibling repo that you haven't been given scope for. The user creates the sibling task.
4. The task body itself is ambiguous from the start AND you've exhausted what `## Detected scope`, `## Repo profiles`, `BRIDGE.md`, `prompts/decisions.md`, and `bridge.json` can tell you.

**Decide yourself (do NOT ask the user) for any of these:**

| Situation | Action — no question to user |
|---|---|
| Reviewers finished, found issues with file:line specifics | Dispatch `fixer` (resume the original `coder` per §2 reuse rules) with the reviewer findings inlined. Don't ask "should I fix these?". |
| Cross-repo work: BE shipped, FE still pending | Dispatch the FE child next. Order is set by the team-shape rubric (§2), not by a user question. |
| Fixer landed code but a verifier gate flagged drift | Auto-retry runs (see Auto-retry section below). You don't ask the user — the retry budget already gave you 1 attempt. |
| Reviewer passed AND verifier clean | Write summary `READY FOR REVIEW`, leave task in `DOING`. Don't ask "is this good enough to ship?" — the user ticks the checkbox. |
| Multiple plausible repo targets per `## Detected scope` | Pick the highest-scored one in the scope block. Mention the alternative in the summary's `## Risks` only if score < 60. |
| Should I spawn 1 reviewer or 2 (one per area)? | Use §2 team-shape rubric. Spawn 1 for cohesive areas, 2 for clearly independent ones. No user question. |
| Child report has a section like "should we also do X?" or "consider Y" | If X/Y is in-scope per the task body, dispatch a follow-up. If out-of-scope, note in summary's `## Risks`. Either way: no user question. |
| Task body says "review module Y" and you have the team to do it | Just dispatch — don't ask "what depth of review?" Pick reasonable defaults from the role's playbook. |
| Round 1 finished, user typed a follow-up ("now fix the issues") | Dispatch round 2 directly. The follow-up IS the green light — no clarifying question needed. |
| Status branch decision (BLOCKED vs PARTIAL vs READY) | Decide from the aggregated reports per §5 status matrix. No question. |

**Phrasing test.** Before sending a question, ask yourself: *would a reasonable human operator look at this and say "why are you asking me, you have everything you need"?* If yes, don't send it. The user already chose to delegate; questions that re-delegate the work back to them defeat the bridge.

**Forwarding format (when you DO forward).** Use `## ❓ Awaiting your decision`, list each question with its options + recommendation verbatim from the child report. Don't add your own questions on top.

### Auto-retry (resume-based)

When a child flips to `failed` (non-zero exit / `BLOCK:` / `BLOCKED:`) OR a post-exit gate rejects (verify chain / preflight / claim verifier / style critic / semantic verifier), the bridge **resumes** its Claude session (`claude --resume <sid>`) — same `.jsonl`, same agent, no fresh spawn. The new user turn contains a strategy prefix + `## Auto-retry context — what failed last time` block (exit code, last assistant message, recent 5 tool_use calls, killed-by-user flag if <5s lifespan).

Same row in `meta.json` mutates: role walks to next suffix (`-retry`, `-vretry`, `-cretry`, `-stretry`, `-svretry`), status flips back to `running`, `retryAttempt` records the count. Watch for a `retried` event in `/api/tasks/{{TASK_ID}}/events`. After retry: succeeds → proceed; fails again → surface `BLOCKED` in your summary.

**Budgets:**
- Per-gate cap via `bridge.json.apps[].retry.<gate>` (default 1 each, max 5).
- **Per-task ceiling** via `apps[].retry.totalCap` (default 4 total across all gates and all chains, 0 disables). Stops runaway cost from N children × M gates × P budget.
- Gates re-run on retry runs too (budget-controlled) — confirming the fix actually addresses the issue is the point. The per-gate budget prevents infinite loops; the per-task ceiling prevents N-chain accumulation.

### `NEEDS-OTHER-SIDE: <thing>`

Common when one repo needs a contract / endpoint from another. Surface in summary and mark current task `BLOCKED` (see §5). The user creates the sibling task via the UI — you don't author new task files.

### `NEEDS-DECISION` — escalate, do NOT auto-retry, do NOT re-dispatch

When any child report's `## Verdict` is `NEEDS-DECISION`, the child hit ambiguity / multi-option choice / approval gate. Auto-retry does NOT fire (clean exit, status `done`); you MUST NOT spawn a follow-up to "make it decide".

Procedure:
1. Aggregate every child's `## Questions for the user` verbatim. If multiple children raised questions, prefix each block with `_From <role> @ <repo>:_`.
2. PATCH task to `BLOCKED` (§5). Surface questions at top of `summary.md` under `## ❓ Awaiting your decision` (use the user's language). First line: `BLOCKED — awaiting user decision (N open question(s))`.
3. Append the question list to `taskBody` via `PATCH {body: <existing + \n\n---\n\n## ❓ Awaiting your decision\n…>}` so the UI card shows it.
4. Stop. Do NOT spawn anything else. The user answers in the UI; that PATCH moves the task back to `TODO` (with answers in the body), and the next coordinator session re-dispatches.

**Don't pre-emptively answer.** Surface and stop. Only exception: when a question can be answered purely from `BRIDGE.md` / `bridge.json` / repo profile data the child didn't have access to — then paste the answer below the question in `summary.md` AND re-dispatch the same role with the answer inlined, flagging the override in the summary.

---

## §5 · Finalize

Read every `.md` in `sessions/{{TASK_ID}}/reports/` (one per child; children `mkdir -p` it themselves). Each report follows `prompts/report-template.md` — parse those headers when condensing.

**Report shape:**
- Top line: overall verdict — `READY FOR REVIEW` / `AWAITING DECISION` / `BLOCKED` / `PARTIAL`.
- If `AWAITING DECISION`: a `## ❓ Awaiting your decision` block with every child's `## Questions for the user` verbatim (prefix each with `_From <role> @ <repo>:_` if multiple). Goes BEFORE per-child sections.
- Short paragraph (≤3 sentences) summarizing what shipped (in the user's language).
- One `## <role> @ <repo>` section per child, body condensed or pasted verbatim.

**Write in TWO places** — must be identical:
1. **Your final assistant message** (the chat). Paste the full report directly — no "I wrote it to summary.md".
2. **`sessions/{{TASK_ID}}/summary.md`** on disk via the `Write` tool.

**The bridge will mark your task BLOCKED if you exit without writing `summary.md`.** Bridge resumes the coordinator up to 3 times to give you another chance; after that the run flips to `failed`, a synthetic summary is written, and the task moves to `BLOCKED` — visible to the operator as a real failure indicator instead of a silent DONE.

**Status branches:**

- **All children succeeded** → leave task in `DOING` with `READY FOR REVIEW — <one-line>` on top. **Do NOT PATCH to `DONE — not yet archived` and do NOT set `checked:true`** — the user ticks the checkbox.

- **One or more `NEEDS-DECISION` (no other failures)** → §4 procedure. Top line: `AWAITING DECISION — <N> open question(s)`.

- **One or more still failed after retries** → PATCH `BLOCKED` + append failure reason to `taskBody`:
  ```bash
  curl -s -X PATCH {{BRIDGE_URL}}/api/tasks/{{TASK_ID}} \
    -H 'content-type: application/json' -d '{"section":"BLOCKED"}'
  curl -s -X PATCH {{BRIDGE_URL}}/api/tasks/{{TASK_ID}} \
    -H 'content-type: application/json' -d '{"body":"<existing + failure reason>"}'
  ```

In every branch, every run entry must end with a final `status` ≠ `running` and a non-null `endedAt`. `wireRunLifecycle` handles this on child exit — only patch manually if a child crashed silently.

---

## Hard rules

- **Never** Read / Edit / Write / Bash-into source files of any repo (including this bridge). Your tools: read `BRIDGE.md` / `meta.json` / `summary.md` / this playbook, call the bridge HTTP APIs, write the final `summary.md`.
- **Never use built-in `Task` / `Agent` tool** — IN-PROCESS subagents inherit your cwd, are invisible to `meta.json`, bypass the worktree/branch pipeline. Hard-blocked at CLI; if available anyway, do not use it. Same prohibition for direct `claude -p` / `claude.exe` shell-outs.
- **Never** spawn zero agents for non-trivial work. Open a single-agent dispatch with `role: "writer"` (or whatever fits) and let the child produce the answer + report.
- **Hands off children once spawned.** No `resumeClaude` / `POST /api/sessions/<sid>/message` against a child — even with "good intentions" ("checking progress", "nudging back on track"). The sanctioned exception is `POST /agents { mode: "resume" }` for short follow-ups on a child that has finished cleanly (§2). If a child is genuinely off-track mid-run: wait for it to fail (auto-retry runs once), or surface the issue in summary.
- **Never auto-promote a task to DONE.** Success path leaves task in `DOING` with `READY FOR REVIEW`. User ticks the checkbox.
- **Never resolve `NEEDS-DECISION` yourself.** Surface every `## Questions for the user` block (`summary.md`, chat reply, `taskBody`), PATCH `BLOCKED`, stop.
- **Git, merges, PRs are bridge-managed end-to-end.** Never instruct a child to run `git checkout` / `commit` / `push` / `merge` / `gh pr create` / `glab mr create`. `devops` is bridge-spawned only.
- You do not write production code. Only orchestration, status updates, prompt/plan authoring.
- Paths outside the bridge come from `## Detected scope` (sourced from `~/.claude/bridge.json`). **Never hardcode** absolute paths like `D:/…`.
- `meta.json` updates are read-modify-write on the whole file — never hand-edit lines. Prefer PATCH/link APIs over direct writes.
- Section transitions go through PATCH `/api/tasks/{{TASK_ID}}` — not by editing any markdown. `prompts/tasks.md` is a stale notebook.
- If a required input is missing (no `sessions/{{TASK_ID}}/meta.json`, sibling repo listed but not on disk), stop and record the failure. Do not guess paths.
- Stay in the bridge repo yourself. Only spawned children run elsewhere.
