# Agentic Remote Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four P0 gaps (Telegram plan approval, tunnel→publicUrl wiring, auto-detected verify commands, fail-loud gates) plus the P1/P2 roadmap so a phone-only operator can drive coding end-to-end with minimal taps while output stays gated.

**Architecture:** Every feature extends an existing subsystem in place: Telegram commands reuse the plan-approve route's libs (`setIntake` + `continueCoordinator`), tunnels write back through the existing `setManifestPublicUrl`, verify detection is a new pure lib called from `addApp`, and fail-loud is a small escalation helper called from the existing gate `blocked` branches in `runLifecycle.ts`. No new services, no schema migrations (bridge.json fields are all optional-additive).

**Tech Stack:** Next.js 16 App Router (nodejs runtime), TypeScript, Vitest, Telegram Bot API (long-poll), web-push (P2-B only new dependency).

## Global Constraints

- Runtime-agnostic: everything must run identically under Bun, npm, pnpm (no Bun-only APIs in `libs/` or `app/`).
- Tests: Vitest, colocated in `libs/__tests__/<name>.test.ts`, run with `bun run test` (or `npx vitest run <file>`).
- All new `bridge.json` manifest fields are OPTIONAL — absent field ⇒ exact pre-change behavior (except Task 3, whose entire point is a new default, and Task 12's documented flip).
- Telegram replies are MarkdownV2 — always escape dynamic text with `escapeMarkdownV2` (see `libs/telegramCommands.ts` for the pattern).
- State-changing API routes keep the existing guard order: CSRF → rate-limit → actor auth (copy the pattern from `app/api/tasks/[id]/plan/approve/route.ts:34-51`).
- Never call `git` / never touch files under `../<other-repo>/`.
- Commit after every task with a conventional-commit message; do NOT push.

---

### Task 1: Telegram plan-gate approval (`/plan`, `/approve`, `/replan`)

**Files:**
- Modify: `libs/telegramCommands.ts` (COMMANDS registry at `:232-372`; side-effecting command fns near `commandDone` at `:560`)
- Modify: `libs/telegramNotifier.ts` (add "plan awaiting approval" ping; follow the `onPermission` pattern at `:591`)
- Modify: `libs/planGateLifecycle.ts` or wherever `setIntake(..., {status:"awaiting-approval"})`-equivalent transition happens — emit/notify hook
- Test: `libs/__tests__/telegramPlanCommands.test.ts`

**Interfaces:**
- Consumes: `readIntake(sessionsDir)`, `setIntake(sessionsDir, patch)` from `libs/meta.ts`; `continueCoordinator(taskId, sessionsDir, message, opts?)` from `libs/planGateLifecycle.ts`; `readPlanGateConfig()` from `libs/planGateConfig.ts`. Mirror the exact state machine of `app/api/tasks/[id]/plan/approve/route.ts:53-133` (idempotent approve, `maxClarifyRounds` cap on replan, `replan:true` flag).
- Produces: three new `CommandDef` entries: `plan` (read-only: show intake status/summary/questions for `/plan <taskId>`), `approve` (`/approve <taskId>` → approve current plan, `approvedBy: {kind:"operator", label:"telegram"}`), `replan` (`/replan <taskId> <note>` → request-changes with note, respecting `maxClarifyRounds`, returning the cap error text when exceeded).

- [ ] **Step 1: Write failing tests** in `libs/__tests__/telegramPlanCommands.test.ts`. Use the existing test helpers (`libs/__tests__/helpers/fs.ts`) to build a temp sessions dir with a task whose intake is `{status:"awaiting-approval", rounds:0, answers:[], summary:"plan summary", questions:[]}` (check `libs/meta.ts` for the exact `Intake` shape first). Test cases:
  - `commandPlanShow` returns text containing the intake status and summary.
  - `commandPlanApprove` flips intake to `approved` and returns a ✅ message; second call returns an "already approved" idempotent message.
  - `commandPlanApprove` on a task with `intake.status === "none"` returns "no plan to act on".
  - `commandPlanReplan` with `rounds >= maxClarifyRounds` returns the cap message and does NOT bump rounds.
  - `commandPlanReplan` under the cap flips status to `planning` and bumps `rounds`.
  - Mock `continueCoordinator` (vi.mock the module) — assert it was called with `{replan:true}` for replan and without for approve.
- [ ] **Step 2: Run tests, verify FAIL** (`npx vitest run libs/__tests__/telegramPlanCommands.test.ts`).
- [ ] **Step 3: Implement.** Export the three command fns from `libs/telegramCommands.ts` (export them for tests, same as other command helpers if they're exported — if not, export a `__testing` object like other libs do; check repo convention first). Register in `COMMANDS` under a new `── Plan gate ──` section. Handler bodies replicate the route logic (do NOT fetch the HTTP route — call the libs directly, matching how `commandDone` calls `updateTask`).
- [ ] **Step 4: Notifier ping.** In the notifier, when a task's intake transitions into the awaiting-approval state, send: `📋 Plan ready for review — <taskTitle>\n/plan <id> · /approve <id> · /replan <id> <note>`. Find the transition point by grepping `awaiting` in `libs/` — hook it the same way section-transitions are forwarded (subscribeMetaAll consumer in `telegramNotifier.ts`). Respect `notificationLevel` (send at `normal`+).
- [ ] **Step 5: Run full test file + typecheck** (`npx vitest run libs/__tests__/telegramPlanCommands.test.ts && bun run typecheck`). Expected: PASS.
- [ ] **Step 6: Commit** `feat(telegram): plan-gate approval via /plan, /approve, /replan + awaiting-approval ping`

### Task 2: Tunnel → publicUrl wiring + auto-start at boot

**Files:**
- Modify: `libs/tunnels.ts` (URL-flip points at `:263` and `:278`; `stopTunnel:356`, `removeTunnel:374`, `killAllTunnels:391`)
- Modify: `libs/apps.ts` (tunnels manifest section near `TunnelManifestSection:754`; add `autoStart` field)
- Modify: `instrumentation.ts` (auto-start hook after `installShutdownHandlers()`)
- Modify: `app/api/tunnels/providers/route.ts` or a new `app/api/tunnels/settings/route.ts` (GET/PUT autoStart setting; follow `app/api/settings/confidence/route.ts` pattern)
- Test: `libs/__tests__/tunnels.test.ts` (extend existing)

**Interfaces:**
- Consumes: `setManifestPublicUrl(input: string): string` and `getManifestPublicUrl()` from `libs/apps.ts:1215/1202`; `startTunnel(opts)`, `TunnelEntry`.
- Produces: `getTunnelAutoStart(): {enabled: boolean, provider: "localtunnel"|"ngrok", port: number} | null` and `setTunnelAutoStart(v): void` in `libs/apps.ts` (stored under `bridge.json#tunnels.autoStart`); `maybeAutoStartTunnel(): Promise<void>` exported from `libs/tunnels.ts`.

- [ ] **Step 1: Write failing tests** in the existing `libs/__tests__/tunnels.test.ts` style:
  - When a tunnel entry flips to `running` **and** its `port` equals the bridge port (`resolveBridgePort()` — grep `libs/paths.ts` for the port helper; if none is exported, compare against `Number(process.env.BRIDGE_PORT ?? process.env.PORT ?? 7777)` extracted into a tiny helper), `setManifestPublicUrl(entry.url)` is called. Non-bridge ports must NOT touch publicUrl.
  - When that same tunnel stops (stop/remove/killAll) and `getManifestPublicUrl()` still equals its URL, publicUrl is cleared (`setManifestPublicUrl("")`). If the operator changed publicUrl meanwhile, leave it alone.
  - `getTunnelAutoStart`/`setTunnelAutoStart` round-trip through a temp manifest.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.** Extract the "entry just became running" logic into one private `onTunnelRunning(entry)` called from both regex-match sites (`:263`, `:278`). Guard `setManifestPublicUrl` in try/catch (log-warn only — never crash the stdout parser). Same for `onTunnelStopped(entry)` from stop/remove/killAll.
- [ ] **Step 4: Auto-start.** `maybeAutoStartTunnel()`: read `getTunnelAutoStart()`; if enabled, call `startTunnel({port, provider})` in try/catch with a `[tunnels] auto-start failed:` warn. Wire into `instrumentation.ts` after shutdown handlers with a dynamic import (same style as the other hooks). Add the settings route (operator-only PUT `{enabled, provider, port}`, validate provider ∈ {localtunnel, ngrok} and port ∈ 1..65535).
- [ ] **Step 5: Run tests + typecheck. Expected: PASS.**
- [ ] **Step 6: UI wire-up (small):** on the Tunnels page component (grep `app/` for the tunnels page), add an "Auto-start on boot" toggle bound to the new settings route, and show a hint when a running tunnel is serving as public URL. Keep styling identical to neighboring toggles.
- [ ] **Step 7: Commit** `feat(tunnels): write live tunnel URL into publicUrl + optional auto-start at boot`

### Task 3: Auto-detect verify commands when an app is added

**Files:**
- Create: `libs/verifyDetect.ts`
- Modify: `libs/apps.ts` (`addApp:1005` — populate `verify` when absent)
- Modify: `app/api/apps/[name]/scan/route.ts` or the apps auto-detect flow so re-scan also backfills empty verify (grep first; only touch the natural seam)
- Test: `libs/__tests__/verifyDetect.test.ts`

**Interfaces:**
- Consumes: `AppVerify` from `libs/apps.ts:154` (`{test?, lint?, build?, typecheck?, format?}` — each one shell command line).
- Produces: `detectVerifyCommands(appPath: string): AppVerify` — pure, synchronous, no LLM.

- [ ] **Step 1: Write failing tests** with temp dirs (helpers in `libs/__tests__/helpers/fs.ts`):
  - `package.json` with `scripts: {test, lint, build, typecheck}` → maps each to `<pm> run <script>` where `<pm>` is `bun` if `bun.lock`/`bun.lockb` exists, `pnpm` if `pnpm-lock.yaml`, `yarn` if `yarn.lock`, else `npm`.
  - Script named `tsc`/`type-check`/`check-types` counts as typecheck; `fmt`/`format` as format. `test` script equal to the npm default placeholder (`echo "Error: no test specified" && exit 1`) is skipped.
  - Go marker (`go.mod`) → `{test:"go test ./...", build:"go build ./...", format:"gofmt -l ."}`. Rust (`Cargo.toml`) → `{test:"cargo test", build:"cargo build", lint:"cargo clippy -- -D warnings"}`. Python (`pyproject.toml`) → `test:"pytest"` only if `pytest` appears in the file text.
  - Empty dir → `{}`.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement `libs/verifyDetect.ts`** (~80 lines, pure fs reads + JSON parse in try/catch).
- [ ] **Step 4: Wire into `addApp`:** in `apps.ts:1005`, when `input.verify` is absent/empty, call `detectVerifyCommands(input.path)` and store the result (empty object stays empty — `hasAnyVerifyCommand` already treats `{}` as "no chain"). Add a test in `libs/__tests__/appsVerify.test.ts` asserting `addApp` on a temp dir with a package.json gets a populated `verify`.
- [ ] **Step 5: Backfill on rescan:** in the scan/auto-detect seam, if the app's current `verify` is empty, refresh it from `detectVerifyCommands` (never overwrite operator-set commands).
- [ ] **Step 6: Run both test files + typecheck. Expected: PASS.**
- [ ] **Step 7: Commit** `feat(apps): auto-detect verify commands (test/lint/build/typecheck/format) on add + rescan backfill`

### Task 4: Fail-loud gates — escalate to BLOCKED + Telegram when QA dies silently

**Files:**
- Create: `libs/gateEscalation.ts`
- Modify: `libs/runLifecycle.ts` — every gate branch that returns `"blocked"` WITHOUT a scheduled retry (verify-crash `:242-251`, verify-fail-no-retry `:264-266`, and the analogous no-retry branches of preflight / claim / style / semantic — locate each by grepping `return "blocked"`), plus the retry-exhaustion early-returns.
- Modify: `libs/qualityGate.ts` (`:254-274` fail-soft skipped path — notify)
- Test: `libs/__tests__/gateEscalation.test.ts`

**Interfaces:**
- Consumes: `updateTask(id, patch)` from `libs/tasksStore.ts` (same call `commandDone` uses); Telegram notify — grep `libs/telegramNotifier.ts` for the lowest-level exported "send" helper the notifier uses and reuse it (do NOT hand-roll a bot call).
- Produces: `escalateGateBlock(opts: {taskId: string, sessionsDir: string, gate: "verify"|"preflight"|"claim"|"style"|"semantic", reason: string, retryScheduled: boolean}): Promise<void>` — when `retryScheduled` is false: PATCH task section to `"BLOCKED"`, append one line to the run's meta (reuse an existing free-text field if one exists — check `Run` type first; otherwise put the reason in the notification only), and send `🚨 QA gate <gate> blocked <taskId> with no retry left: <reason>`. Also `notifyGateInfraSkip(opts: {taskId, gate, detail})` for the qualityGate skipped path (notify only, no section change).

- [ ] **Step 1: Write failing tests:** `escalateGateBlock` with `retryScheduled:false` flips a temp task's section to BLOCKED and calls the (mocked) notify fn; with `retryScheduled:true` it does neither; notify failures are swallowed (task still flips). `notifyGateInfraSkip` calls notify with the gate name and never throws.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement `libs/gateEscalation.ts`** (~60 lines; all effects individually try/caught — escalation must NEVER throw into `postExitFlow`).
- [ ] **Step 4: Call sites.** In `runLifecycle.ts`: verify-crash branch → `escalateGateBlock({... gate:"verify", reason:"verify chain crashed — inconclusive", retryScheduled:false})`; each `chain failed … retry ineligible` branch → same with the failed step name. In `qualityGate.ts`, where an agent gate resolves to `skipped` because of spawn failure / timeout / non-JSON verdict (NOT the legit "playbook absent" skip — separate those two cases if currently merged) → `notifyGateInfraSkip`.
- [ ] **Step 5: Run the new test file plus `libs/__tests__/verifyChain.test.ts`, `semanticVerifier.test.ts`, `styleCritic.test.ts` (regression) + typecheck. Expected: PASS.**
- [ ] **Step 6: Commit** `feat(reliability): fail-loud QA — BLOCKED + Telegram ping on gate block without retry, notify on gate infra skip`

### Task 5: "Recommended automation" preset for apps

**Files:**
- Modify: `libs/apps.ts` (export the preset constant)
- Modify: apps API + Add-app UI: `app/api/apps/route.ts` (accept `preset:"recommended"` on POST), the Add-app dialog component (grep `app/` for "Add app"), and the auto-detect accept flow.
- Test: `libs/__tests__/appsQuality.test.ts` (extend)

**Interfaces:**
- Produces: `RECOMMENDED_GIT_SETTINGS: AppGitSettings = { branchMode:"auto-create", fixedBranch:"", autoCommit:true, autoPush:false, worktreeMode:"disabled", mergeTargetBranch:"", integrationMode:"none" }` (safe-by-default: commits land on a `claude/<task-id>` branch, nothing leaves the machine) and `applyRecommendedPreset(app: App): App` which sets git to the preset and `quality.critic = true`, leaving any operator-customized non-default values untouched (compare against `DEFAULT_GIT_SETTINGS` field-by-field; only overwrite fields still at default).

- [ ] **Step 1: Write failing tests:** preset applied to a default-settings app yields the values above; an app where the operator already set `branchMode:"fixed"` keeps `fixed`.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement + wire:** `POST /api/apps` body gains optional `preset`; UI Add-app dialog gets a checked-by-default "Use recommended automation (branch per task + auto-commit + style critic)" checkbox; auto-detect accept applies the preset the same way.
- [ ] **Step 4: Run tests + typecheck. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(apps): one-click recommended-automation preset on add/auto-detect`

### Task 6: Gate status embedded in summary (API + notifier + UI badge)

**Files:**
- Create: `libs/gateStatus.ts`
- Modify: `app/api/tasks/[id]/summary/route.ts` (`:12-19` — include computed gate status)
- Modify: `libs/telegramNotifier.ts` (`renderCoordinatorSummaryMessage:499` — append gate line)
- Modify: the task-detail summary component (grep `app/` for where summary.md renders) — red/green badge row
- Test: `libs/__tests__/gateStatus.test.ts`

**Interfaces:**
- Consumes: `Meta`/`Run` from `libs/meta.ts` (gate fields `verify`, `verifier`, `styleCritic`, `semanticVerifier`, `confidence` on each run — read the exact shapes at `libs/meta.ts:46`).
- Produces: `computeGateStatus(meta: Meta): {gates: Array<{name: string, verdict: "pass"|"fail"|"skipped"|"held", detail?: string}>, allGreen: boolean}` — aggregates across the LATEST run per (role, repo) chain (follow `retryOf` to the newest attempt), ignoring coordinator runs; `renderGateStatusMarkdown(status): string` producing a compact `## Gate status` table.

- [ ] **Step 1: Write failing tests:** meta with a passing verify + semantic `pass` → `allGreen:true`; meta where the newest retry attempt failed verify → `fail` (the older attempt must not mask it); confidence-held run → `held`; no gates configured → `gates:[]`, `allGreen:true`.
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement lib**, then: summary route returns `{summary, gateStatus}` (keep raw-text behavior for existing consumers — check who calls this route and preserve their contract; if consumers expect plain text, add `?format=json`), notifier appends `Gates: ✅ all green` or `Gates: 🔴 verify fail` to the Ready-for-review message, UI shows badges above the summary.
- [ ] **Step 4: Run tests + typecheck. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(tasks): gate-status aggregation surfaced in summary API, Telegram, and task UI`

### Task 7: Confidence hold for worktree mode (opt-in)

**Files:**
- Modify: `libs/confidenceScore.ts` (`shouldHoldOutward:95`)
- Modify: `libs/confidenceConfig.ts` + `app/api/settings/confidence/route.ts` (new `holdWorktree` field, default `false`)
- Modify: `libs/runLifecycle.ts` worktree merge-back path (`:850-943`) — respect the hold: skip merge-back + integration, stamp `confidence.heldAt`, keep the worktree alive
- Modify: `app/api/tasks/[id]/runs/[sessionId]/confidence/review/route.ts` — `ship` on a held worktree run performs the deferred merge-back (reuse the exact merge code path — extract it into an exported fn if it's inline)
- Test: `libs/__tests__/confidenceWorktree.test.ts`

**Interfaces:**
- Produces: `shouldHoldOutward(score, cfg, isWorktree)` new behavior: when `cfg.holdWorktree === true`, worktree runs hold below threshold like normal runs; default (absent/false) keeps today's never-hold.

- [ ] **Step 1: Write failing tests:** `{enabled:true, threshold:70, holdWorktree:true}` + score 50 + worktree → `true`; same with `holdWorktree:false` → `false`; config round-trip persists `holdWorktree`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** score/config change, then the runLifecycle + review-route plumbing. The merge-back extraction must be behavior-preserving for the unheld path — run `libs/__tests__/worktrees.test.ts` as regression.
- [ ] **Step 4: Run new + worktrees + confidence-related test files + typecheck. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(confidence): optional hold for worktree runs (holdWorktree setting) with deferred merge on ship`

### Task 8: PWA manifest + install metadata

**Files:**
- Create: `public/manifest.webmanifest`, `public/icon-192.png`, `public/icon-512.png` (rasterize `public/logo.svg` — if no rasterizer available offline, generate simple PNGs from the SVG with a node script using no new deps is impossible; instead ship maskable SVG icons: `public/icon.svg` referenced with `type:"image/svg+xml"`, which Chromium accepts)
- Modify: `app/layout.tsx` (`metadata`: `manifest:"/manifest.webmanifest"`, `themeColor`, `appleWebApp:{capable:true, title:"Claude Bridge"}`)

**Interfaces:** none (static assets).

- [ ] **Step 1: Write the manifest** — `{name:"Claude Bridge", short_name:"Bridge", start_url:"/tasks", display:"standalone", background_color:"#12151c", theme_color:"#12151c", icons:[{src:"/icon.svg", sizes:"any", type:"image/svg+xml", purpose:"any maskable"}]}`.
- [ ] **Step 2: Wire metadata in layout.tsx** (Next 16: `themeColor` belongs in the `viewport` export — check the existing `viewport` export at `app/layout.tsx:25`).
- [ ] **Step 3: Verify:** `bun run build` compiles; `curl localhost:7777/manifest.webmanifest` (dev server) returns the JSON.
- [ ] **Step 4: Commit** `feat(pwa): installable manifest + standalone metadata`

### Task 9: Web push notifications

**Files:**
- Create: `public/sw.js` (push + notificationclick only, no caching), `libs/webPush.ts`, `app/api/push/subscribe/route.ts`, `app/api/push/vapid/route.ts` (GET public key), client hook `libs/client/usePushSubscribe.ts` + a "Enable notifications" button in the settings page
- Modify: `libs/telegramNotifier.ts` → rename-safe: add a parallel fan-out so the same events (permission pending, ready-for-review, BLOCKED, plan awaiting) also go to web-push subscribers (extract a `libs/notifyFanout.ts` if cleaner, but do NOT restructure the telegram code paths)
- Modify: `package.json` (add `web-push` dependency)
- Test: `libs/__tests__/webPush.test.ts`

**Interfaces:**
- Produces: `libs/webPush.ts`: `ensureVapidKeys(): {publicKey: string}` (generate once via `webpush.generateVAPIDKeys()`, persist under `BRIDGE_STATE_DIR/push-keys.json`, mode 0600); `addSubscription(sub: PushSubscriptionJSON): void` / `removeSubscription(endpoint: string): void` (persist `BRIDGE_STATE_DIR/push-subs.json`); `sendPushToAll(payload: {title: string, body: string, url?: string}): Promise<void>` (drop 404/410 subs).

- [ ] **Step 1: Write failing tests** for key persistence round-trip, add/remove subscription, and `sendPushToAll` pruning dead subs (mock `web-push`).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: `bun add web-push && bun add -d @types/web-push`, implement lib + routes** (subscribe route: cookie-auth only, CSRF-checked, operator or guest both fine).
- [ ] **Step 4: Service worker + client:** `sw.js` shows `event.data.json()` as notification, click focuses/opens `url`. Hook: register SW, `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`, POST to subscribe route. Button in settings page with permission-state feedback.
- [ ] **Step 5: Fan-out:** call `sendPushToAll` beside the four Telegram notify sites (guard: try/catch + no-op when zero subs).
- [ ] **Step 6: Run tests + typecheck + `bun run build`. Expected: PASS.**
- [ ] **Step 7: Commit** `feat(push): web-push notifications (VAPID, SW, subscribe API, event fan-out)`

### Task 10: Telegram login approvals (`/logins`, `/approvelogin`, `/denylogin`)

**Files:**
- Modify: `libs/telegramCommands.ts` (three commands), `libs/telegramNotifier.ts` (ping on new pending login)
- Modify: `libs/loginApprovals.ts` (expose list/approve/deny if not already exported; add an event/callback hook for "pending created" — grep how it stores `PendingLogin` first)
- Test: `libs/__tests__/telegramLoginCommands.test.ts`

**Interfaces:**
- Consumes: `PendingLogin` store in `libs/loginApprovals.ts` (TTL 3 min).
- Produces: `/logins` lists pending logins (id-prefix, UA, IP, age); `/approvelogin <idPrefix>` / `/denylogin <idPrefix>` resolve by unique prefix (≥6 chars, ambiguity error — copy the prefix-matching UX from `commandPermissionAnswer:825`); notifier pings `🔐 New device login pending: <ua> from <ip> — /approvelogin <prefix>` when a pending login is created.

- [ ] **Step 1: Write failing tests** (list/approve/deny/prefix-ambiguity/expired).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement + register commands + notifier hook.**
- [ ] **Step 4: Run new tests + `libs/__tests__/loginApprovals.test.ts` regression + typecheck. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(telegram): approve device logins from Telegram`

### Task 11: Auto-queue — autonomous TODO dispatch

**Files:**
- Create: `libs/autoQueue.ts`
- Modify: `libs/scheduler.ts` (call the auto-queue tick from the existing 30s tick, inside the process-lock guard)
- Create: `app/api/settings/auto-queue/route.ts` (GET/PUT `{enabled: boolean, maxConcurrent: number}`, default `{enabled:false, maxConcurrent:1}`; follow the confidence settings route pattern)
- Modify: settings UI page — toggle + concurrency input next to the other reliability settings
- Test: `libs/__tests__/autoQueue.test.ts`

**Interfaces:**
- Consumes: task listing (`libs/tasksStore.ts` — the same source `renderTasks` uses), `spawnCoordinatorForTask(task)` from `libs/coordinator.ts`, `readMeta`.
- Produces: `autoQueueTick(): Promise<void>` — when enabled: count tasks whose meta has a `running` coordinator run; if `< maxConcurrent`, take the OLDEST `TODO` task with zero runs and no intake in progress, and `spawnCoordinatorForTask` it (which flips it to DOING via the normal path). One spawn per tick maximum. Never touches BLOCKED/DOING tasks.

- [ ] **Step 1: Write failing tests:** disabled → no spawn; enabled with 0 running and two TODO tasks → spawns exactly the oldest; enabled with `maxConcurrent:1` and 1 running coordinator → no spawn; task with existing runs is skipped. Mock `spawnCoordinatorForTask`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement lib + settings route + scheduler wiring + UI toggle.**
- [ ] **Step 4: Run tests + typecheck. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(autonomy): auto-queue — scheduler dispatches TODO tasks under a concurrency cap`

### Task 12: Prompt-cache split default-on

**Files:**
- Modify: `app/api/tasks/[id]/agents/route.ts:161` (the `BRIDGE_PROMPT_CACHE` gate)
- Modify: docs page env-var table (`app/docs/page.tsx`) + `README.md` env table if it lists the var
- Test: whichever existing test covers the prompt split (grep `BRIDGE_PROMPT_CACHE` in `libs/__tests__/`)

- [ ] **Step 1: Flip semantics:** enabled unless `BRIDGE_PROMPT_CACHE === "0"` (was: only when `=== "1"`). Update the env-reading helper + its test.
- [ ] **Step 2: Run the agents-route-related test files + typecheck. Expected: PASS.**
- [ ] **Step 3: Commit** `perf(spawn): prompt-cache system/user split on by default (BRIDGE_PROMPT_CACHE=0 to disable)`

### Task 13: Deprecated cleanup

**Files:**
- Delete: `libs/repoHeuristic.ts` (deprecated shim) — first `grep -r "repoHeuristic" app/ libs/ scripts/` and migrate every importer to the detect-layer function the shim wraps (the shim body at `libs/repoHeuristic.ts` shows the real target)
- Modify: `libs/paths.ts:67` — remove the `@deprecated` export after migrating its importers
- Delete: `libs/__tests__/repoHeuristic.test.ts` (or rewrite against the detect layer if it covers real logic)

- [ ] **Step 1: Migrate importers** (mechanical rename per the shim's forwarding).
- [ ] **Step 2: Delete shim + deprecated export.**
- [ ] **Step 3: Run FULL suite `bun run test` + `bun run typecheck` + `bun run lint`. Expected: PASS.**
- [ ] **Step 4: Commit** `chore: remove deprecated repoHeuristic shim and paths export`

---

## Final integration checklist (after Task 13)

- [ ] `bun run test` — full suite green
- [ ] `bun run typecheck` — clean
- [ ] `bun run lint` — clean
- [ ] `bun run build` — compiles (catches route/manifest/SW issues)
- [ ] Smoke: boot dev server, confirm the startup banner shows no new errors, `/manifest.webmanifest` serves, tunnels settings page loads.
