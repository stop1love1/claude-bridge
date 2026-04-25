# Agentic-Coder Layer — Roadmap

Goal: turn the bridge into a plugin that helps Claude produce task-completion code that matches the existing codebase style. Token-optimized phasing: each phase ships in its own session so context stays fresh; later phases build on earlier infrastructure.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## P1 — Foundation (D1 + C3 + H1) — ✅ DONE

Shipped 2026-04-25. Wires 3 opt-in inputs into the spawn pipeline.

| Item | Surface |
|---|---|
| ✅ D1 — `verify` field on `bridge.json` per app | `lib/apps.ts` (AppVerify, normalize/serialize, `updateAppVerify`); `app/api/apps/[name]/route.ts` (PATCH) |
| ✅ C3 — global + per-app `house-rules.md` loader | `lib/houseRules.ts` |
| ✅ H1 — `bridge/playbooks/<role>.md` loader | `lib/playbooks.ts` |
| ✅ Inject all 3 into child prompt | `lib/childPrompt.ts` (3 new opts: `houseRules`, `playbookBody`, `verifyHint`) + spawn route loads them |
| ✅ Tests | `lib/__tests__/houseRules.test.ts`, `playbooks.test.ts`, `appsVerify.test.ts`, updated `childPrompt.test.ts` + `repos.test.ts` |

Section order in child prompt (opt-in sections only emitted when content present):

```
Header → Language → House rules → Task → Your role (playbook + brief)
       → Repo profile → Repo context → Self-register → Report contract
       → Verify commands → Spawn-time signals
```

**Backward compat:** apps with no verify, no house-rules.md, no playbook → prompt identical to pre-P1. Verified by `childPrompt.test.ts` "emits sections in the contracted order".

**Convention decisions locked in:**
- Team-shared markdown lives under `bridge/` (committed). New subdirs allowed: `bridge/playbooks/`, `bridge/house-rules.md`.
- Per-app local rules live under `<appPath>/.bridge/house-rules.md` inside the sibling repo (each repo owns its own gitignore policy for that file).
- `bridge.json` field default = empty/missing means "feature off" — never an error. Opt-in everywhere.
- 32 KB byte cap on every read-from-disk markdown the bridge inlines into prompts.
- `process.cwd()` is the seam for testing path-based loaders (mock with `vi.spyOn(process, "cwd")` + `vi.resetModules()` before importing).

**Deferred from P1 (low-priority, picked up where natural):**
- L1 — `AppVerify` is duplicated in `lib/apps.ts` and `lib/client/types.ts` (matches existing duplication of `AppGitSettings`/`App` — leave for a focused dedup task that addresses all of them at once).
- L2 — no explicit byte-cap overflow test on house-rules / playbooks (32 KB is comfortable; revisit only if a real overflow surfaces).

---

## P2 — Verify chain (split into P2a ✅ + P2b ⬜)

Goal: turn the verify contract into a feedback loop + add style-critic gating commits. Split because E1+C1 need a sane spawn/playbook surface that's easier to design after the runner ships.

---

## P2a — Verify chain runner + auto-retry + commit gate — ✅ DONE

Shipped 2026-04-26. ~300K tokens (explore 65K + impl 200K + review 50K).

| Item | Surface |
|---|---|
| ✅ D2 — Verify chain runner | `lib/verifyChain.ts` — `runVerifyChain({cwd, verify, timeoutMs?, outputCapBytes?, onStep?})` runs `format → lint → typecheck → test → build` in canonical order, stops on first failure, skips unconfigured steps |
| ✅ D4 — Auto-retry on verify fail | `spawnVerifyRetry` mirrors `childRetry.spawnRetryRun` pattern (direct spawn, no HTTP self-loop). Distinct `-vretry` role suffix keeps budget separate from crash `-retry`. Retry context block injected at top of prompt with failed step name + cmd + raw output |
| ✅ C2 partial — Block commit on verify fail | `lib/coordinator.ts:postExitFlow` runs verify chain BEFORE `autoCommitAndPush`. Verify fail → block commit + spawn retry (if eligible). Verify pass → commit as before |
| ✅ Schema | `Run.verify?: RunVerify` + `RunVerifyStep` types added to `lib/meta.ts`. Optional, backward compat |
| ✅ Race safety | Single combined `updateRun({status, endedAt, verify})` patch. Async post-exit wrapped in `.catch()` so unhandled rejection can't crash dev server |
| ✅ Cross-platform exec | `spawn(cmd, [], {shell: true, windowsHide: true, signal: ac.signal})` — Node delegates `cmd /c` on Windows, `sh -c` on POSIX. AbortController for timeout |
| ✅ Tests | `lib/__tests__/verifyChain.test.ts` — 20 pass, 1 skipped (Windows timeout reaping limit) |

**Conventions locked in for P2:**
- Verify commands run from operator-trusted `bridge.json` — no further sanitization beyond P1's PATCH validation (1024-char cap, trim, key whitelist).
- Empty steps array → `passed: true` (vacuously). Callers needing "did we run anything?" branch on `steps.length`.
- Output cap default 16 KB, marker appended on truncate. UTF-8 may drop 1-3 trailing bytes at the cap boundary — acceptable.
- `format` field semantics is team's call (check vs auto-fix). No separate `formatFix` field — the team writes whatever shell command does what they want.

**Issues fixed during P2a review:**
- HIGH C1 — `emitRetried` SSE event not fired after verify-retry → fixed: imported + called after non-null spawn so AgentTree draws `retryOf` arrow.
- HIGH H1 — double `updateRun` race in fail+retry path → fixed: collapsed into single combined patch including `retryScheduled`.
- MED M1 — empty-steps returning `passed:false` was a footgun for direct callers → fixed: changed to vacuously true.

**Issues deferred to P2b cleanup:**
- MED H2 — captured `finishedRun.status:"running"` is misleading (cosmetic only).
- MED H3 — `tryReadOriginalPrompt` duplicated between `verifyChain.ts` and `childRetry.ts`. Extract to shared `lib/promptStore.ts` when touching either next.
- LOW M2 — no integration test for full `postExitFlow → verify → updateRun → spawnVerifyRetry` lifecycle (only unit tests). Add when test infra for lifecycle exists.

---

## P2b — Verifier + style critic + full commit gate — ⬜ NEXT SESSION

Goal: layered quality gates beyond raw verify chain — verifier compares agent claims vs reality, style-critic checks fit, both can block commit.

**Estimated tokens:** ~250K (smaller because P2a infra reused).

### Inputs (already in place from P1)
- `app.verify` per app — already loaded (`getApp(repo).verify`) and surfaced into the child prompt.
- `bridge/playbooks/style-critic.md` — H1 already supports this; just write the playbook.

### Items remaining

| ID | Item | Notes |
|---|---|---|
| E1 | Verifier agent | New playbook `bridge/playbooks/verifier.md`. Spawned automatically after a child + verify chain pass. Reads `summary.md` claims vs `git diff` reality vs verify result. Verdict: PASS / DRIFT / BROKEN. DRIFT/BROKEN triggers a third-tier retry (`-vretry-retry`? or new `-cretry` for "claim retry") with "your claim said X but diff shows Y". Decide retry budget — recommend separate `-cretry` suffix. |
| C1 | Style critic agent | New playbook `bridge/playbooks/style-critic.md`. P2b minimal version: reads diff + global+per-app `house-rules.md` + recent file patterns. Verdict: match / drift / alien. Full power comes in P3 when style fingerprint + symbol index land. |
| C2 full | Block commit if critic = alien | Extend `postExitFlow` after verify pass: spawn critic agent, wait for verdict in `summary.md`, block commit if `alien`. Trigger style-retry. Same `-cretry` suffix family. |

### Cleanup (carried over from P2a deferred list)

- H2 — clarify `finishedRun` snapshot or refactor to re-read inside `postExitFlow` (cosmetic, low priority).
- H3 — extract `tryReadOriginalPrompt` to shared `lib/promptStore.ts` (used by both childRetry + verifyChain; will be needed by E1 + C1 too).
- M2 — add integration test that exercises the full `postExitFlow` path with a fake child process + temp app.

### Hook points (extending P2a infra)

- `lib/coordinator.ts:postExitFlow` — already runs verify then commits. Add: after verify pass, spawn critic; after critic pass, spawn verifier; only commit when all three pass.
- `lib/verifyChain.ts:spawnVerifyRetry` — pattern to mirror for `spawnCriticRetry` and `spawnVerifierRetry`. Extract common helper.
- `bridge/playbooks/<role>.md` — H1 already supports loading these. Just write the markdown; no code change to enable per-role playbooks.

### Schema decisions to make in P2b architect step

1. Verifier and critic roles need separate retry budgets from `-vretry`. Recommendation: `-cretry` ("critic-fail retry") for both. Distinct suffix → independent `isEligibleForCriticRetry` checker.
2. Verifier verdict format — markdown headings in `summary.md`, or separate `<task>/critic.json`? Markdown is simpler but harder to parse. Recommend a small JSON file dropped by the verifier/critic playbook (`sessions/<id>/<role>-verdict.json`).
3. Spawn order: critic before verifier, or in parallel? Sequential (critic first, then verifier on the critic-approved diff) is simpler and cheaper — defer parallelism to P3 if needed.

### Risks (mostly inherited from P2a, plus new)

- Three sequential agent passes per task (coder → critic → verifier) — token cost x3 minimum. Need to make critic and verifier opt-in per app (e.g. `bridge.json.apps[].quality: { critic: true, verifier: false }`).
- Style critic without P3 fingerprint is weak — judgment based only on house-rules.md text + recent file patterns. Document that critic accuracy improves significantly after P3 lands.
- Long total pipeline latency: 3-5 minutes for verify + 30-60s for critic spawn + 30-60s for verifier spawn. UI needs clear "verifying / critiquing / verifying claims" status indicator.

---

## P3 — Style infrastructure (A1 + A2 + B1 + B2)

Goal: agent has codebase fingerprint + symbol index + reference files baked into every prompt, so generated code matches house style automatically.

**Estimated tokens:** ~400K (heavy: code scanning, JSON schema, integration with prompt path).

### Items

| ID | Item | Notes |
|---|---|---|
| A1 | Style fingerprint per app | Scan repo on register/refresh: indent (tabs/spaces, width), quote style, semicolon, trailing comma, import order, default vs named export ratio, file naming (PascalCase.tsx vs kebab-case.tsx), test file convention. Output: `.bridge-state/style/<app>.json`. Inject 5-7 lines into prompt header. |
| A2 | Symbol/utility index | Scan `lib/`, `utils/`, `hooks/` (configurable per app). Extract exported symbols + 1-line signature. Output: `.bridge-state/symbols/<app>.json`. Inject "available helpers" block into prompt — agent reuses instead of recreating. |
| B1 | Mandatory pre-read enforcement | Coordinator playbook (built in P1's H1) instructs "read N relevant files before Edit/Write". Bridge enforces by parsing transcript: if Edit/Write appears before N Read calls, mark run as `failed-preflight` and trigger retry. Hook: post-exit check before declaring run done. |
| B2 | Auto-attach reference files | Heuristic: when child's repo+role match a pattern (e.g., role=coder + repo with Next.js + task body mentions "form"), prepend the contents of 2 most-recent matching files (`forms/*.tsx` LRU by git log) into the prompt. New `lib/contextAttach.ts`. |

### Hook points
- Style fingerprint extraction: use `repoProfile.scanRepo` as a model (already does file walking with caps). Output goes to `.bridge-state/style/`.
- Symbol index: parse via `ts-morph` (consider) or simple regex over `export (const|function|class)` patterns. Cap depth.
- B1 enforcement: check `meta.json` run's transcript for tool call ordering. The transcript is in `~/.claude/projects/<slug>/<sessionId>.jsonl`.

### Decisions needed
- A1 fingerprint refresh trigger: on every spawn (cheap with cached file mtime check), or on app register only? Suggest: on register + on `git pull` detection (compare HEAD).
- B1 N value: default 3? Configurable per app via `bridge.json.preflightReads`?
- B2 heuristic: keyword match on role + repo profile features + task body. May overlap with `repoHeuristic.ts` — share that module.

---

## P4 — Worktree sandbox + diff review UI (F1 + K1)

Goal: every child runs in an isolated `git worktree`. Diff review pane in UI before commit.

**Estimated tokens:** ~300K.

### Items

| ID | Item | Notes |
|---|---|---|
| F1 | Worktree per run | Before spawn, `git worktree add .worktrees/<sessionId> <branch>`. Child runs in worktree cwd. After verify+critic pass: `git worktree remove` + cherry-pick or merge into target branch. Failure: leave worktree for inspection, prune after N hours. |
| K1 | Diff review pane | New UI panel in task detail view: shows `git diff` per run (file tree + hunks) with Approve / Revert / Edit-comment buttons. SSE stream for live updates as child writes. |

### Hook points
- F1 spawn cwd: change `app.path` resolution in `agents/route.ts` to `worktreePath` when feature enabled.
- K1: extend `app/api/tasks/[id]/runs/[sessionId]/` route family with a `diff` endpoint. UI: `app/_components/RunDiffPane.tsx` (new), wire into `app/_components/TaskDetail.tsx`.

### Risks
- Worktrees on Windows: directory lock issues during `worktree remove`. Test on Windows specifically (we're on Windows 11 Pro per env).
- Storage growth in `.worktrees/`. Need pruner (similar to `staleRunReaper.ts`).

---

## P5 — Memory + similar-task RAG (G1 + G2)

Goal: every completed task makes the next one cheaper/better. Embeddings via local transformers.js (decided in P0 alignment — no API cost, no lock-in).

**Estimated tokens:** ~250K + 50MB model download on first run.

### Items

| ID | Item | Notes |
|---|---|---|
| G1 | `.bridge/memory.md` per app | After task DONE, coordinator asked "anything to append? (1-3 lines, format `When X → do Y because Z`)". Bridge prepend on next spawn in same app. Storage: `<appPath>/.bridge/memory.md` (similar location to per-app house-rules). |
| G2 | Similar-task RAG | Embed `taskBody + summary.md` for every DONE task. On new task creation, retrieve top-3 similar with verdict + 1-line learning. Inject into coordinator prompt. Embeddings cache: `.bridge-state/embeddings/<task-id>.bin`. |

### Tech choices
- Embedding model: `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (~50MB, no network after install, runs in node). Embedding dim 384.
- Index: in-memory cosine similarity (sub-100 tasks); migrate to hnswlib-node only if needed.
- New deps: `@xenova/transformers` (~50MB install). Document in README "first task creation downloads the model".

### Decisions needed
- Where to place embedding cache. `.bridge-state/embeddings/` (gitignored per existing convention) ✓.
- When to embed: on task DONE (synchronous) or background queue? Background safer (don't block UI on embed time).
- Memory append flow: coordinator-driven (1 question after summary) or auto-extract from summary? Start with coordinator-driven for accuracy.

---

## Review pass (after each phase)

Use `feature-dev:code-reviewer` agent with this brief shape:

```
Reviewing Phase N. Verify each bullet in "Yêu cầu PN" against implementation.
Output: ✅/⚠️/❌ per bullet, HIGH/MED/LOW issues with file:line, verdict SHIP/NEEDS-FIX/BLOCKED.
Token cap: ≤80K.
```

Issues found by reviewer in P1 (resolved during P1 session):
- HIGH H1 — `repos.test.ts:117` fixture missing `verify: {}` → fixed.
- MED M1 — `updateAppVerify` not wired to PATCH route → fixed (verify branch + char cap added).
- MED M2 — redundant `process.chdir` in test cleanup → removed.
- LOW L1 — duplicate `AppVerify` definition (matches existing pattern) → deferred.
- LOW L2 — no byte-cap overflow test → deferred.

Issues found by reviewer in P2a (resolved during P2a session):
- HIGH C1 — `emitRetried` SSE not fired after verify-retry → fixed (imported + called).
- HIGH H1 — double `updateRun` race in fail+retry path → fixed (collapsed to one combined patch with `retryScheduled`).
- MED M1 — empty-steps `passed:false` was a footgun → fixed (vacuously true now).
- MED H2/H3 — `finishedRun` snapshot clarity + `tryReadOriginalPrompt` duplication → deferred to P2b cleanup.
- LOW M2 — no integration test for full lifecycle → deferred.

---

## Token cost summary (estimate)

| Phase | Tokens | Notes |
|---|---|---|
| ✅ P1 | ~390K actual | Includes explore + impl + review |
| ✅ P2a | ~315K actual | Verify chain runner + auto-retry + commit gate |
| ⬜ P2b | ~250K | Verifier + style-critic + full commit gate |
| ⬜ P3 | ~400K | Heaviest; codebase scanning + symbol extraction |
| ⬜ P4 | ~300K | UI work + worktree plumbing |
| ⬜ P5 | ~250K | + first-time model download |

**Total ~1.6M tokens to complete the agentic-coder layer end-to-end.** Same as originally estimated — phasing keeps each session within a clean context window. P1 + P2a actual = ~700K (44% of total).

---

## Conventions enforced across all phases

- Opt-in everything — never force a feature on existing apps without explicit config.
- Sync read, fail-soft to `null`, byte-cap (32 KB default) for any markdown the bridge inlines into prompts.
- Server modules use `node:fs` directly; client types live in `lib/client/types.ts` (UI-side mirror, may duplicate server types — existing convention).
- New tests: vitest, mock `process.cwd()` via spy + `vi.resetModules()` for path-based loaders.
- Section order in child prompt is contract — append-only, never reorder.
- Coordinator never edits source code (per existing `bridge/coordinator.md`).
- Bridge owns git checkout/commit/push (per existing `bridge.json.git` settings).
- Prefer extending `bridge/` for team-shared markdown over creating new top-level dotdirs.
