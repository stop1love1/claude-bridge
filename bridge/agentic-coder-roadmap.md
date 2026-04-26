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

**Convention decisions locked in:**
- Team-shared markdown lives under `bridge/` (committed). New subdirs allowed: `bridge/playbooks/`, `bridge/house-rules.md`.
- Per-app local rules live under `<appPath>/.bridge/house-rules.md` inside the sibling repo.
- `bridge.json` field default = empty/missing means "feature off" — never an error. Opt-in everywhere.
- 32 KB byte cap on every read-from-disk markdown the bridge inlines into prompts.
- `process.cwd()` is the seam for testing path-based loaders.

---

## P2 — Verify chain (P2a ✅ + P2b-1 ✅ + P2b-2 ✅)

Goal: turn the verify contract into a feedback loop + add quality-gating commits.

### P2a — Verify chain runner + auto-retry + commit gate — ✅ DONE

Shipped 2026-04-26.

| Item | Surface |
|---|---|
| ✅ D2 — Verify chain runner | `lib/verifyChain.ts` — `runVerifyChain` runs `format → lint → typecheck → test → build` in canonical order, stops on first failure. |
| ✅ D4 — Auto-retry on verify fail | `spawnVerifyRetry` mirrors `childRetry.spawnRetryRun`. Distinct `-vretry` role suffix. |
| ✅ C2 partial — Block commit on verify fail | `coordinator.ts:postExitFlow` runs verify chain BEFORE `autoCommitAndPush`. |
| ✅ Schema | `Run.verify?: RunVerify` + `RunVerifyStep` types. |
| ✅ Cross-platform exec | `spawn(cmd, [], {shell: true, windowsHide: true, signal: ac.signal})`. |
| ✅ Tests | `lib/__tests__/verifyChain.test.ts`. |

**Conventions:** Verify commands run from operator-trusted `bridge.json`. Empty steps array → `passed: true` (vacuously). Output cap default 16 KB.

### P2b-1 — Inline claim-vs-diff verifier — ✅ DONE

Shipped 2026-04-26.

| Item | Surface |
|---|---|
| ✅ Inline verifier | `lib/verifier.ts` — parses child report `## Changed files` + runs `git status --porcelain=v1` + derives verdict. |
| ✅ 4-state verdict | `pass` / `drift` / `broken` / `skipped`. Lockfile churn filtered. |
| ✅ Schema | `Run.verifier?: RunVerifier`. |
| ✅ Claim-retry | `spawnClaimRetry` with distinct `-cretry` suffix. |
| ✅ Wire into postExitFlow | Runs AFTER verify chain, BEFORE autoCommit. |
| ✅ H3 cleanup | Extracted `tryReadOriginalPrompt` → `lib/promptStore.ts:readOriginalPrompt`. |
| ✅ Tests | `verifier.test.ts` (23 cases) + `promptStore.test.ts` (5 cases). |

**Conventions:** 3-tier retry budget (`-retry`, `-vretry`, `-cretry`), each cap=1 per (parent, role) pair. `succeedRun`'s status flip deferred to `postExitFlow` whenever a post-exit gate runs.

### P2b-2 — Agent-driven style critic + semantic verifier — ✅ DONE

Shipped 2026-04-26. Both gates opt-in per app, default off.

| Item | Surface |
|---|---|
| ✅ C1 — Style critic agent | `lib/styleCritic.ts` — spawns the `style-critic` role via the shared gate runner, parses `style-critic-verdict.json`, returns `match` / `drift` / `alien` / `skipped`. Retry suffix `-stretry`. |
| ✅ E1 — Semantic verifier agent | `lib/semanticVerifier.ts` — same shape, role `semantic-verifier`, reads `semantic-verifier-verdict.json`, verdicts `pass` / `drift` / `broken` / `skipped`. Retry suffix `-svretry`. |
| ✅ Shared gate runner | `lib/qualityGate.ts` — `runAgentGate({...})` does spawn / await-exit-with-timeout / read-verdict-JSON. |
| ✅ Schema | `App.quality?: AppQuality` (`{critic?: boolean; verifier?: boolean}`), `Run.styleCritic?: RunStyleCritic`, `Run.semanticVerifier?: RunSemanticVerifier`. PATCH `/api/apps/<name>` accepts `quality` partial. |
| ✅ Playbooks | `bridge/playbooks/style-critic.md` + `bridge/playbooks/semantic-verifier.md`. |
| ✅ Wire into postExitFlow | Branches after the inline verifier branch and before auto-commit. |
| ✅ Retry suffix matcher | `isAlreadyRetryRun` extended to recognize `-stretry` and `-svretry`. |
| ✅ Tests | `styleCritic.test.ts` (14 cases), `semanticVerifier.test.ts` (13 cases), `appsQuality.test.ts` (5 cases). |

**Conventions:**
- Both gates default OFF.
- 5 retry suffixes total: `-retry` (crash) + `-vretry` (verify) + `-cretry` (claim-vs-diff or preflight) + `-stretry` (style critic) + `-svretry` (semantic verifier).
- Quality gates spawn the agent via `spawnFreeSession` directly and manually flip the gate's run status on exit — no `wireRunLifecycle` to avoid recursive `postExitFlow`.
- Verdict files live next to (sibling of) the `reports/` dir at `sessions/<task-id>/<role>-verdict.json`.

---

## P3 — Pre-spawn data layer (P3a ✅ + P3b ✅)

### P3a — Symbol index + pinned files + style fingerprint — ✅ DONE

Shipped 2026-04-26.

| Item | Surface |
|---|---|
| ✅ A2 — Symbol/utility index | `lib/symbolIndex.ts` regex-based scanner. `lib/symbolStore.ts` caches at `.bridge-state/symbol-indexes.json` with 24h TTL. |
| ✅ B3 — Pinned files | `App.pinnedFiles` + `App.symbolDirs` added. `lib/pinnedFiles.ts` loads with per-file 4KB cap, 8-file max. |
| ✅ A1 — Style fingerprint | `lib/styleFingerprint.ts` samples up to 50 files, tallies indent/quote/semicolon/trailingComma/exports/fileNaming via `pickMajority`. `lib/styleStore.ts` caches with 24h TTL. |
| ✅ Wire into childPrompt | 3 new opt-in sections: `## House style`, `## Available helpers`, `## Pinned context`. |
| ✅ Tests | `symbolIndex.test.ts`, `styleFingerprint.test.ts`, `pinnedFiles.test.ts`. |

**Token-budget invariants:** `SYMBOLS_PROMPT_CAP = 30`, pinned 4 KB × 8 = 32 KB max, fingerprint ≤8 lines.

### P3b — Pre-read enforcement + auto-attach + recent commits — ✅ DONE

Shipped 2026-04-26.

| Item | Surface |
|---|---|
| ✅ B1 — Mandatory pre-read | `lib/preflightCheck.ts` — counts Read/Grep/Glob/LS before first Edit. Verdict `pass`/`fail`/`skipped`. `spawnPreflightRetry` reuses `-cretry` budget. |
| ✅ B2 — Auto-attach references | `lib/contextAttach.ts` — tokenizes task body, scores symbol-index entries by substring match, picks top 3 files. |
| ✅ B4 — Recent direction | `lib/recentDirection.ts` — runs `git log --stat -10 -- <dir>`. |
| ✅ Wire into childPrompt | 2 new sections: `## Recent direction`, `## Reference files`. |
| ✅ Tests | `preflightCheck.test.ts`, `contextAttach.test.ts`, `recentDirection.test.ts`. |

**Final child-prompt section order:**
```
Header → Language → House rules → House style → Memory → Task → Your role
       → Repo profile → Available helpers → Repo context
       → Recent direction → Pinned context → Reference files
       → Self-register → Report contract → Verify commands
       → Spawn-time signals
```

---

## P4 — Worktree sandbox + diff API — ✅ DONE (F1 + K1 API; React UI deferred)

Shipped 2026-04-26.

| Item | Surface |
|---|---|
| ✅ F1 — Worktree per run | `lib/worktrees.ts` — `createWorktreeForRun` mints `<appPath>/.worktrees/<sessionId>` on a unique per-spawn branch (`claude/wt/<task>-<sid>`) forked from a base resolved via `branchMode`. `mergeAndRemoveWorktree` merges back into the base branch (in the live tree) and removes the worktree on Windows-friendly `--force` + `rmSync` fallback. `pruneStaleWorktrees` reaps idle worktrees older than `BRIDGE_WORKTREE_STALE_HOURS` (default 24h), called opportunistically from `GET /api/apps`. |
| ✅ Schema | `App.git.worktreeMode: "disabled" \| "enabled"` (default disabled, opt-in). `Run.worktreePath / worktreeBranch / worktreeBaseBranch` for cleanup + diff. PATCH `/api/apps/<name>` validates the new mode. |
| ✅ Wire spawn | `agents/route.ts` skips `prepareBranch` when worktreeMode is enabled (worktree owns its branch), creates the worktree pre-spawn, uses the worktree path as the child's cwd + the prompt-rendered `repoCwd`, persists the trio of worktree fields on the run. |
| ✅ Wire post-exit | `coordinator.ts:postExitFlow` runs verify chain / preflight / inline verifier / style critic / semantic verifier all rooted at `run.worktreePath ?? app.path` so each gate sees the agent's actual diff. After auto-commit (in worktree, autoPush suppressed), `mergeAndRemoveWorktree` lands the work on the base branch in the live tree. When `app.git.autoPush` is on, a final push pass runs against the LIVE base branch. |
| ✅ Worktree-aware retries | All six retry paths (`childRetry`, `verifyChain`, `verifier`, `preflightCheck`, `styleCritic`, `semanticVerifier`) inherit the parent's `worktreePath / Branch / BaseBranch` via `inheritWorktreeFields` and spawn in the same worktree. |
| ✅ K1 partial — diff API | `GET /api/tasks/<id>/runs/<sessionId>/diff` returns `{ kind, cwd, diff, truncated? }`. Diff body capped at 256 KB. `isUnderAppRoot` defense check. |
| ✅ Tests | `lib/__tests__/worktrees.test.ts` — 12 cases (8 integration with real git). |

**Issues found by reviewer (resolved during P4 session):**
- HIGH H1 — `branchMode=fixed` against an already-checked-out branch failed silently → fixed: `mintSpawnBranch` always returns a unique `claude/wt/<task>-<sid>`; `resolveBaseBranch` resolves the fork target separately.
- HIGH H2 — `appendMemory` truncation used char-based `slice` after a byte-based `Buffer.byteLength` check → fixed: byte-aware `Buffer.subarray + toString("utf8") + drop trailing partial line`.
- MED M1 — auto-push pushed throwaway worktree branch instead of merged result → fixed: autoCommit in worktree with autoPush suppressed; dedicated push pass against live base branch after merge.
- MED M2 — pruner used directory mtime, missed worktrees where only existing files were modified → fixed: walk top-level children + take max mtime.
- MED M3 — concurrent `auto-create` spawns collided on the same branch → fixed via H1.
- LOW L1 — diff endpoint trusted `meta.json`'s `worktreePath` verbatim → fixed: `isUnderAppRoot` guard.

**Deferred:**
- K1 React UI — `RunDiffPane` component + wiring into `TaskDetail.tsx`. The diff endpoint contract is stable.

### Conventions locked in (P4)
- Worktrees live at `<appPath>/.worktrees/<sessionId>`. Operator's responsibility for per-app `.gitignore`.
- Spawn branch always `claude/wt/<task-id>-<short-sid>`. Base branch resolved by `branchMode`; missing branches fall back to current HEAD.
- A spawn that fails worktree creation falls back to the live tree (degraded mode) with a console warning.
- Pruner TTL configurable via `BRIDGE_WORKTREE_STALE_HOURS` (default 24).

---

## P5 — Memory + similar-task RAG — G1 ✅ DONE / G2 ⬜ DEFERRED

### P5/G1 — Per-app memory.md — ✅ DONE

Shipped 2026-04-26.

| Item | Surface |
|---|---|
| ✅ G1 — `.bridge/memory.md` per app | `lib/memory.ts` — `loadMemory`, `topMemoryEntries`, `appendMemory` (idempotent against immediate duplicates, byte-aware truncation at 32 KB, oldest entries dropped on overflow). Storage at `<appPath>/.bridge/memory.md`, newest entry first. |
| ✅ Inject into prompts | `buildChildPrompt` adds `## Memory (learnings from prior tasks in this app)` section after `## House style`, gated on non-empty `memoryEntries`. `agents/route.ts` and `qualityGate.ts` both load top-12 entries. |
| ✅ API | `GET /api/apps/<name>/memory` returns `{ entries: string[] }`. `POST` accepts `{ entry: string }`, validates length (≤1024 chars), trims + flattens to a single bullet, prepends to file. |
| ✅ Tests | `lib/__tests__/memory.test.ts` — 14 cases. |

### Conventions locked in (G1)
- Memory file is operator-managed: each app/team picks gitignore policy independently.
- Entry format is conventional, not enforced.
- 12-entry prompt cap keeps the worst-case `## Memory` injection under ~6 KB.
- Distinct from `house-rules.md` — that file is for STATIC team constraints; memory is for DYNAMIC accreted learnings.

### G2 deferred — pickup checklist

| ID | Item | Notes |
|---|---|---|
| G2 | Similar-task RAG | Embed `taskBody + summary.md` for every DONE task. On new task creation, retrieve top-3 similar with verdict + 1-line learning. Inject into coordinator prompt. |

Tech choices (locked):
- Embedding model: `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (~50MB, ~384 dim).
- Index: in-memory cosine similarity (sub-100 tasks); migrate to hnswlib-node only if needed.
- Embeddings cache: `.bridge-state/embeddings/<task-id>.bin` (gitignored).
- Embed on task DONE in a background queue.

---

## Token cost summary (final)

| Phase | Tokens | Notes |
|---|---|---|
| ✅ P1 | ~390K actual | Foundation — verify schema + house-rules + playbooks |
| ✅ P2a | ~315K actual | Verify chain runner + auto-retry + commit gate |
| ✅ P2b-1 | ~280K actual | Inline claim-vs-diff verifier + cretry budget |
| ✅ P3a | ~370K actual | Symbol index + pinned files + style fingerprint |
| ✅ P3b | ~280K actual | Preflight enforcement + auto-attach references + recent direction |
| ✅ P2b-2 | ~240K actual | Agent-driven style critic + semantic verifier |
| ✅ P4 | ~280K actual | Worktree-per-run + diff API (K1 React UI deferred) |
| ✅ P5/G1 | ~80K actual | Memory.md per app (G2 RAG deferred) |
| ⬜ K1 UI | ~60K | RunDiffPane React component + wire into TaskDetail |
| ⬜ G2 | ~250K | Similar-task RAG (transformers.js, ~50MB model) |

**Total shipped ≈ ~2.2M tokens (~92% of original roadmap budget).** All "data + verification + quality gates + sandbox + memory" infra is in place.

Two distinct opt-in features remain:
- **K1 UI** — React diff review pane consuming `/api/tasks/<id>/runs/<sid>/diff`. Endpoint contract stable; ship the UI in a focused frontend session.
- **G2 RAG** — needs `npm install @xenova/transformers` (~50MB). Belongs in its own checkpoint so the dep change is isolated.

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

---

## Review pass (after each phase)

Use `feature-dev:code-reviewer` agent with this brief shape:

```
Reviewing Phase N. Verify each bullet in "Yêu cầu PN" against implementation.
Output: ✅/⚠️/❌ per bullet, HIGH/MED/LOW issues with file:line, verdict SHIP/NEEDS-FIX/BLOCKED.
Token cap: ≤80K.
```

Issues found by reviewers (resolved during their respective sessions):
- P1: H1 fixture missing `verify`, M1 PATCH wiring, M2 redundant chdir.
- P2a: C1 missing emitRetried, H1 double updateRun race, M1 empty-steps footgun.
- P2b-1: HIGH-1 missing await on updateRun, HIGH-2 unawaited appendRun, MED-1 status flip race.
- P3a: M1 symbolDirs path traversal, M2 function-component test gap.
- P3b: H1 outer retry guard, H3 repoCwd vs app.path slug divergence.
- P2b-2: shipped clean, internal QA notes only.
- P4: H1 fixed-branch worktree collision, H2 byte-aware memory truncation, M1 auto-push misroute, M2 pruner mtime walk, M3 concurrent auto-create collision, L1 diff path defense.
