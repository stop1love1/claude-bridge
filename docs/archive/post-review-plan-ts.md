# Post-Review Implementation Plan

Source: comprehensive review (security + code-quality + UI/UX + perf + architecture) completed 2026-05-02. This document drives the sprint-by-sprint refactor on branch `refactor/post-review-sprints`.

Each sprint is executed by one implementer agent followed by one reviewer agent. Sprints run sequentially because Sprint 1 introduces a shared helper (`libs/atomicWrite.ts`) consumed by later sprints, and Sprint 3's dead-code removal depends on Sprint 1's API contract decision.

Out of scope here: **Sprint 5** (`postExitFlow` pipeline refactor + retry-suffix split + resource-tree reconcile) — multi-day effort, will be planned separately.

## Conventions for every sprint

- Run `bun run typecheck` and `bun run test` before declaring sprint done.
- One commit per sprint with message `refactor(sprint-N): <summary>` co-authored line per CLAUDE.md commit policy.
- Do not change behavior outside the sprint's stated scope. If a fix touches unrelated code, stop and flag it.
- Follow existing patterns in the file you edit. Match indentation, import style, naming.
- Comments: only add a comment when the WHY is non-obvious. Don't narrate WHAT.

## Sprint 1 — Security + atomic-write hardening

### S1.1 — Timing-safe internal-token compare in devices route
**File:** `app/api/auth/devices/route.ts:35`
**Current:** `if (internal && cfg.internalToken && internal === cfg.internalToken)`
**Fix:** Replace `===` with `constantTimeStringEqual(internal, cfg.internalToken)` (already exported from `libs/auth.ts`, used by `proxy.ts:144`).

### S1.2 — CSRF must verify token, not just header presence
**File:** `libs/csrf.ts:58`
**Current:** Bypass if `req.headers.get(INTERNAL_TOKEN_HEADER)` is truthy.
**Fix:** Use `constantTimeStringEqual(headerToken, loadAuthConfig().internalToken)` to actually verify the token before allowing the bypass. Keep the existing Sec-Fetch-Site/Origin/Referer logic for cookie-only callers.

### S1.3 — Demo mode must short-circuit auth routes
**Files:** `app/api/auth/login/route.ts`, `app/api/auth/setup/route.ts`
**Current:** Proxy matcher excludes `api/auth/`, so `BRIDGE_DEMO_MODE=1` does not block these.
**Fix:** Add at the top of each handler:
```ts
import { isDemoMode } from "@/libs/demoMode";
if (isDemoMode()) return NextResponse.json({ error: "demo mode" }, { status: 503 });
```
Audit other `app/api/auth/**/route.ts` handlers (logout, me, approvals, login/pending) and add the same guard where it makes sense.

### S1.4 — Enforce 0600 permissions on `bridge.json`
**File:** `libs/bridgeManifest.ts` (around the `writeFileSync` in `updateBridgeManifest`)
**Current:** No `chmod` after write — file inherits umask (often 0644 on POSIX).
**Fix:** After `renameSync` (or `writeFileSync`), call `chmodSync(BRIDGE_JSON, 0o600)` guarded by `process.platform !== "win32"`. Pattern already used in `libs/setupToken.ts:71-79`.

### S1.5 — Extract shared atomic-write helper
**New file:** `libs/atomicWrite.ts`
**API:**
```ts
export function writeJsonAtomic(filePath: string, value: unknown, opts?: { mode?: number }): void;
export function writeStringAtomic(filePath: string, content: string, opts?: { mode?: number }): void;
```
**Implementation:** mkdir parent, unique tmp suffix (`${pid}.${Date.now()}.${random}.tmp`), `writeFileSync(tmp, payload)`, optional `chmodSync(tmp, mode)`, `renameSync(tmp, filePath)`, cleanup tmp on rename failure.

**Migrate callers:**
- `libs/profileStore.ts:69` (uses `${path}.tmp` — race-prone)
- `libs/styleStore.ts:95` (same)
- `libs/symbolStore.ts:115` (same)
- `libs/meta.ts:23` (already safe; migrate for consistency)
- `libs/bridgeManifest.ts` (already mostly safe; migrate)

After Sprint 1, this is the canonical atomic-write helper. Sprint 2/3 may call it but should not re-introduce ad-hoc tmp+rename.

### Tests
- Add `libs/__tests__/atomicWrite.test.ts` covering: success path, parallel writers don't lose data, tmp cleanup on rename failure, `mode` option applies.
- Existing tests for the migrated stores must still pass without change.

---

## Sprint 2 — Performance wins

### S2.1 — Stream-based `tailJsonl`
**File:** `libs/sessions.ts:126` (`tailJsonl`)
**Current:** `Buffer.alloc(size - fromOffset)` — allocates entire tail into RAM.
**Fix:** Read in fixed chunks (e.g. 256 KB) using `readSync(fd, buf, 0, CHUNK, offset)` in a loop, splitting on newlines and yielding parsed entries. Use `StringDecoder` for multi-byte boundaries. Pattern already in `scanSessionHead` at `libs/sessions.ts:345`.
**Behavior:** Keep public signature identical. New entries returned in same order.

### S2.2 — Cache `sumUsageFromJsonl` by `(path, mtime, size)`
**File:** `libs/sessionUsage.ts:48`
**Current:** `readFileSync(filePath, "utf8").split("\n")` every call, no cache.
**Fix:** Module-level `Map<string, { mtime: number; size: number; usage: UsageTotals }>`. Cache hit if `statSync` returns same mtime+size. Cache miss → parse + store. Cap cache at ~256 entries (LRU not strictly needed, but evict oldest insert if exceeded).

### S2.3 — In-flight dedupe + response cache for `/api/tasks/meta`
**File:** `app/api/tasks/meta/route.ts:20`
**Current:** Reaps stale runs for every task on every request. Multi-tab dashboards stack requests.
**Fix:**
1. Wrap handler body in `withInFlight("tasks-meta", "all", async () => { ... })` (helper at `libs/inFlight.ts`).
2. Add a response cache `let lastResponse: { at: number; payload: ... } | null = null;` with 1.5s TTL. Bust on `subscribeMetaAll` events.
3. Confirm `metaCache` (the underlying read cache) still does its job — don't double-cache wastefully.

### S2.4 — Decouple streaming `partials` from `SessionLogInner`
**File:** `app/_components/SessionLog.tsx` (around line 443 where `partials` lives)
**Current:** `setPartials` updates trigger reconciliation of the entire 300-row tree on every token (50/s).
**Fix:** Lift `partials` into a small dedicated context (or `useSyncExternalStore`-backed store). The streaming "ghost" row consumes it directly; the rest of the tree does not re-render on token deltas. Keep public component API the same.
**Verification:** open a long transcript, stream a long reply, check React DevTools profiler for reduced re-renders on non-streaming rows.

### S2.5 — Cache `scanSessionHead` by `(path, mtime, size)`
**File:** `libs/sessions.ts:345`
**Current:** Re-reads up to 4 MB head per call. `/api/sessions/all` triggers many.
**Fix:** Same pattern as S2.2 — Map cache keyed by `${path}:${mtime}:${size}`. Most session files don't change after the run ends → high hit rate.

### Tests
- Add a focused unit test for the new `tailJsonl` confirming chunked-vs-direct read produce identical output for files of varying sizes.
- Add a test for the usage cache hit/miss based on `mtime` change.
- No UI tests — manual smoke check is fine for S2.4.

---

## Sprint 3 — Dead code + API contract + test core

### S3.1 — Delete dead task-list code
**Files:**
- `libs/tasks.ts` — remove `parseTasks`, `serializeTasks`, `renderTask`, `sectionPlaceholder`. Keep `Task`, `TaskStatus`, `TaskSection`, `SECTION_STATUS`, `isValidTaskId`, `generateTaskId`, anything still imported from production code.
- `libs/sessions.ts:262` — remove `findSessionByPrefix` (no production caller; only the test imports it).
- Delete `prompts/tasks.md`.
- Update `libs/__tests__/tasks.test.ts` and `libs/__tests__/sessions.test.ts` to drop the now-removed cases.
- Remove the comment in `app/api/sessions/[sessionId]/route.ts:19` ("The bridge `tasks.md` entry stays") — replace with a note that runtime state lives in `meta.json`, or just delete the comment if the surrounding code already implies it.

**Before removing each export:** grep the repo to confirm no production caller imports it. If anything still imports it, leave it and flag in the implementer report.

### S3.2 — API response contract
**New file:** `libs/apiResponse.ts` — short JSDoc and helpers:
```ts
/** Success: return the payload object directly (e.g. { tunnel, tasks }). */
/** No-content success (DELETE, kill): return { ok: true }. */
/** Error: use serverError() / safeErrorMessage() — always { error: string }. */
export function ok(): Response;
export function ok<T>(payload: T): Response;
```
**Migrate the worst offenders only:** any route currently returning a mix of `{tunnel}` for 200 and `{ok}` for DELETE is fine to leave. Routes returning raw arrays at the top level (no envelope) — if any — should be normalized. Don't churn 50 files; pick the ~5-10 inconsistent ones flagged in the review.
**Document:** add a top-of-file JSDoc in `libs/errorResponse.ts` linking to `apiResponse.ts`.

### S3.3 — Tests for orchestration core
Add focused unit tests (mocked I/O — do not spawn real `claude`):

- `libs/__tests__/coordinator.test.ts` — test prompt template substitution ordering (placeholder → splice → user content), fallback when `readBridgeMd` throws.
- `libs/__tests__/spawn.test.ts` — extend existing test: cover `buildCoordinatorArgs` shape with/without `disallowedTools`, verify `settingsArgs` rejects unknown mode/effort/model strings.
- `libs/__tests__/runLifecycle.test.ts` — minimum: state-transition guards (`succeedRun` defers when a gate is pending; `failRun` does not demote `done`; `attachGateResult` does not double-flip status). Mock the gate modules with `vi.mock`.

Each new test file should land green with `bun run test`.

---

## Sprint 4 — UI/UX polish

### S4.1 — Permission dialog button hierarchy
**Files:** `app/_components/PermissionDialog.tsx`, `app/_components/GlobalPermissionDialog.tsx`
**Current:** `AlertDialogCancel` (Deny) is tinted destructive red on the left; `AlertDialogAction` (Allow) is the primary on the right and receives default focus.
**Fix:**
- Allow button: primary (blue/accent), keeps right side, **does not** receive auto-focus.
- Deny button: outline destructive, **receives auto-focus** (`autoFocus` on the cancel element). Keep left side.
- Description gets a small subtext: "Esc keeps the popup open. Click Deny to refuse."
- The existing `onOpenChange={() => {}}` keep-popup-open behavior stays — do not let Esc auto-deny.

### S4.2 — ConfirmDialog auto-focus Cancel when destructive
**File:** `app/_components/ConfirmProvider.tsx`
**Current:** Action button is default focused.
**Fix:** When `destructive=true`, `<AlertDialogCancel autoFocus>` so an accidental Enter does not delete.

### S4.3 — Loading state on `/tasks` mount
**Files:** `app/tasks/page.tsx`, `app/_components/TaskGrid.tsx`
**Current:** Empty array initial state → `EmptyState "No tasks yet"` flashes for ~hundreds of ms before first refresh resolves.
**Fix:**
- `tasks/page.tsx`: add `loading` state, `setLoading(true)` initially, `setLoading(false)` in `finally` of first `refreshTasks()`.
- Pass `loading` down to `TaskGrid`. When `loading && tasks.length === 0`, render skeleton rows instead of EmptyState.
- Reuse the existing skeleton primitive from `app/_components/ui/skeleton.tsx`.

### S4.4 — SessionLog "spawning" placeholder with spinner + ETA
**File:** `app/_components/SessionLog.tsx:1233`
**Current:** Italic plain text "Waiting for session output…".
**Fix:** Replace with a small flex row: spinner (Loader2 icon spinning) + line "Spawning coordinator… first response usually arrives in 5-15s." If after 30s still no output, swap to "Still spawning. Check the terminal where you started the bridge for errors." (use `setTimeout` or a `useEffect` with elapsed counter).

### S4.5 — Mobile TaskDetail breakpoint
**File:** `app/tasks/[id]/page.tsx:399-432`
**Current:** Two-pane layout only at `lg:` (≥1024 px); tablets are stuck on tab toggle.
**Fix:** Drop to `md:` (≥768 px). Adjust `lg:max-w-2xl xl:max-w-3xl` cascade so md:width is reasonable (e.g. `md:max-w-md lg:max-w-2xl xl:max-w-3xl`). Verify the chat pane doesn't overflow on iPad-portrait sizes by reading the surrounding flex/grid code.

### S4.6 — Async confirm support in ConfirmProvider
**File:** `app/_components/ConfirmProvider.tsx`
**Current:** `confirm()` resolves immediately on click; caller does its async work after dialog closes — no progress.
**Fix:** Extend `ConfirmOptions` with optional `onConfirm?: () => Promise<void>`. When provided, dialog stays open with both buttons disabled and a small spinner on the action button until the promise resolves (or rejects, in which case re-enable). Backwards-compatible: callers without `onConfirm` work unchanged.
**Update one or two destructive callers** to use the new API (e.g. `tasks/page.tsx:171-186` delete-task path) to demonstrate the pattern.

### Tests
- Existing tests pass.
- Manual smoke: open `/tasks` → see skeleton; open a task → see spawn placeholder; trigger a permission popup → confirm focus on Deny; trigger delete → see spinner.

---

## Out of scope (Sprint 5, future)

The pipeline-refactor work — `Gate` interface + `GatePipeline` runner, `claim`/`preflight` retry-suffix split, resource-tree reconcile (`/api/sessions` vs `/api/runs` vs `/api/transcripts`) — needs its own plan written via `superpowers:writing-plans`, with migration steps for existing `meta.json` data. Don't start it as part of this branch.
