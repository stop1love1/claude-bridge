# Migration Sessions — Lộ trình theo session

> Tài liệu phụ trợ cho `MIGRATION_GO.md`. Chia 7 phase thành **42 session** (mỗi session ~1 lần Claude chạy, 2-5 giờ work). Đọc kèm `MIGRATION_GO.md` — phần này chỉ là index thực thi, scope chi tiết + acceptance vẫn ở plan gốc.
>
> **Branching**: tất cả session commit lên 1 nhánh dài hạn `migration/go` (strangler-fig giữ Next chạy song song). Rebase định kỳ với `main`.
>
> **Cách dùng**: mỗi session, mở 1 Claude session mới, paste:
> ```
> Đọc MIGRATION_GO.md + MIGRATION_SESSIONS.md, làm session <Sxx>.
> Trước khi code: ack acceptance criteria. Khi xong: chạy verification, commit, báo done.
> ```

---

## Quy ước session

| Trường | Ý nghĩa |
|---|---|
| `Phase` | Phase trong `MIGRATION_GO.md §5` |
| `Task ID` | Task trong plan gốc (link tới prompt §6 nếu có) |
| `Depends` | Session phải xong trước |
| `Scope` | File TS source → Go target |
| `Accept` | Verify trước khi commit |
| `Effort` | Ước tính giờ work |

---

## Phase 0 — Foundation (4 session)

### S01 — Branch + OpenAPI inventory
- **Phase**: 0 · **Task ID**: 0.1 · **Depends**: — · **Effort**: 3-4h
- **Setup**: `git checkout -b migration/go` từ `main`. Thêm `.gitignore` entries: `bin/`, `dist/`, `web/dist/`, `*.exe`.
- **Scope**: đọc toàn bộ `app/api/**/route.ts` (65 route) → `api/openapi.yaml` v0.1. Path + method + path/query params có type, body schema dùng `x-todo: true` nếu chưa rõ. `operationId` lowerCamelCase.
- **Codegen verify**:
  - `npx openapi-typescript api/openapi.yaml -o web/src/api/schema.ts` (OK với strict TS)
  - `oapi-codegen -generate types,chi-server -package api api/openapi.yaml > internal/api/openapi_gen.go`
- **Accept**: 65 path đúng method; cả 2 codegen không lỗi; commit.

### S02 — Go server skeleton
- **Phase**: 0 · **Task ID**: 0.2 (§6.1) · **Depends**: S01 · **Effort**: 2-3h
- **Scope**: `cmd/bridge/main.go` (cobra, subcommand `serve --port 8080`); `internal/server/server.go` (chi + zerolog + recover + CORS `:7777` + cookie parser); `GET /api/health` → `{status,version,uptime}`; `go.mod` với `chi/v5`, `cobra`, `zerolog`.
- **Accept**: `go run ./cmd/bridge serve` chạy; `curl :8080/api/health` 200 + JSON; `golangci-lint run ./...` clean.

### S03 — Module skeleton + Makefile + CI
- **Phase**: 0 · **Task ID**: 0.3 + 0.4 + 0.5 · **Depends**: S02 · **Effort**: 2-3h
- **Scope**: `internal/{api,spawn,sessions,meta,git,auth,detect,telegram,tunnels,permission,memory,quality,symbol,upload,usage,middleware,config}/doc.go` rỗng; `Makefile` targets `dev` (air + vite proxy), `build` (vite build → embed → go build), `test`, `contract`, `lint`; `.github/workflows/go.yml` matrix Windows/Linux/macOS.
- **Accept**: `make build` thành công; CI xanh trên PR draft.

### S04 — Contract test framework
- **Phase**: 0 · **Task ID**: 0.6 + 0.7 (§6.8) · **Depends**: S03 · **Effort**: 4-5h
- **Scope**: `test/contract/{seed,record,replay}.go`; `cmd/contract/main.go` (subcommand `record|verify|verify-all`); fake `claude` binary trong `test/fixtures/`; pilot endpoint `GET /api/tasks/meta` (Go trả stub đúng shape, contract verify pass).
- **Header normalization**: ignore `Date`, `Set-Cookie` expiry, `X-Request-Id` (document trong `test/contract/README.md`).
- **Accept**: `make contract` pass với 1 endpoint pilot; framework có thể nhân rộng.

---

## Phase 1 — Core domain (10 session)

### S05 — Sessions reader (1.1 part A)
- **Phase**: 1 · **Task ID**: 1.1 · **Depends**: S04 · **Effort**: 4-5h
- **Scope**: `libs/sessions.ts`, `sessionEvents.ts`, `sessionListCache.ts` → `internal/sessions/`. Endpoints `GET /api/sessions`, `GET /api/sessions/all`, `GET /api/sessions/:id`. JSONL parser respect message format Claude Code.
- **Accept**: contract verify pass cho 3 endpoint; `internal/sessions/sessions_test.go` parity với `libs/__tests__/sessions.test.ts` case count.

### S06 — Usage stats (1.1 part B)
- **Phase**: 1 · **Task ID**: 1.1 · **Depends**: S05 · **Effort**: 2-3h
- **Scope**: `libs/sessionUsage.ts`, `usageStats.ts` → `internal/usage/`. Endpoints `GET /api/usage`, `GET /api/tasks/:id/usage`.
- **Accept**: contract verify pass; test parity.

### S07 — Spawn engine core (1.2 part A)
- **Phase**: 1 · **Task ID**: 1.2 (§6.3) · **Depends**: S06 · **Effort**: 5-6h
- **Scope**: `libs/spawn.ts`, `spawnRegistry.ts`, `processKill.ts` → `internal/spawn/{spawn.go,registry.go,process_kill_windows.go,process_kill_unix.go}`. Cross-platform: Windows job objects (kill grandchildren), POSIX setpgid+killpg. Stdout capture vào `sessions/<task>/<sid>.log` + channel notify.
- **Accept**: spawn fake-claude prints `session: abc-123\nhello\n`, verify `Run.SessionID="abc-123"`, log file đầy đủ; kill trước exit không để orphan (test bằng `ps`).

### S08 — Spawn retry & reaper (1.2 part B)
- **Phase**: 1 · **Task ID**: 1.2 · **Depends**: S07 · **Effort**: 3-4h
- **Scope**: `retrySpawn.ts`, `childRetry.ts`, `staleRunReaper.ts`, `shutdownHandler.ts`, `inFlight.ts` → `internal/spawn/{retry.go,reaper.go,shutdown.go}` + `inFlight` dùng `sync.Map` trong `registry.go`.
- **Accept**: retry ladder kích hoạt với exit code 1, give-up sau N lần; reaper kill PID-gone; shutdown SIGTERM all → wait → SIGKILL fallback.

### S09 — Meta atomic write
- **Phase**: 1 · **Task ID**: 1.3 prep · **Depends**: S08 · **Effort**: 2-3h
- **Scope**: `internal/meta/meta.go` — atomic read/write `sessions/<id>/meta.json` qua tempfile + `os.Rename`, file lock single-writer (vd `flock`/`LockFileEx`). Match shape `meta.json` hiện tại bytewise.
- **Accept**: golden test ghi rồi đọc lại bằng Next code → identical; concurrent write test không lost-update.

### S10 — Tasks API read (1.3 part A)
- **Phase**: 1 · **Task ID**: 1.3 (§6.4) · **Depends**: S09 · **Effort**: 4-5h
- **Scope**: GET handlers — `/api/tasks`, `/api/tasks/meta`, `/api/tasks/{id}`, `/api/tasks/{id}/meta`, `/api/tasks/{id}/summary`, `/api/tasks/{id}/usage`. Wire qua `oapi-codegen` chi mount.
- **Accept**: contract verify pass cả 6 endpoint; cookie auth middleware bật trừ `/link`.

### S11 — Tasks API write (1.3 part B)
- **Phase**: 1 · **Task ID**: 1.3 · **Depends**: S10 · **Effort**: 5-6h
- **Scope**: POST/PATCH/DELETE — create, update (incl. section move), archive; `/clear`, `/link` (token bypass), `/agents` (enqueue qua spawn engine, KHÔNG shell out trực tiếp), `/continue`, `/runs/{sid}/{kill,prompt,diff}`, `/summary` PUT.
- **Constraint**: section transition chỉ 4 giá trị hợp lệ; coordinator không auto-promote sang `DONE — not yet archived`.
- **Accept**: contract verify pass; smoke test create→spawn→kill→archive qua UI Next (rewrites `:8080`).

### S12 — Tasks SSE + detect refresh (1.3 part C)
- **Phase**: 1 · **Task ID**: 1.3 · **Depends**: S11 · **Effort**: 3-4h
- **Scope**: `GET /api/tasks/{id}/events` (SSE: event names `task.event`, `agent.detect.progress`, ping ≤30s), `POST /api/tasks/{id}/detect/refresh`.
- **Accept**: contract framework record 5 event đầu, framing `data:` byte-match Next; ping interval đúng.

### S13 — Auth cookies (1.4 part A)
- **Phase**: 1 · **Task ID**: 1.4 (§6.5) · **Depends**: S12 · **Effort**: 4-6h ⚠️ rủi ro
- **Decision point**: inspect `libs/auth.ts` xem cookie là `iron-session` (AES-GCM) hay khác.
  - **A**: Go decoder tương thích → zero downtime (thử trước, nếu blocked >1 ngày escalate).
  - **B**: đổi sang JWT/Paseto → force re-login + RELEASE_NOTES (cần coordinator approve).
- **Scope**: `internal/auth/{cookies.go,password.go,setup_token.go,approvals.go}`; bcrypt cùng cost factor.
- **Accept**: round-trip test cookie Next ↔ Go (cả 2 chiều) — verify hot rolling upgrade.

### S14 — Auth handlers + middleware (1.4 part B)
- **Phase**: 1 · **Task ID**: 1.4 · **Depends**: S13 · **Effort**: 4-5h
- **Scope**: `internal/middleware/{auth.go,ratelimit.go,errorresp.go}` (token bucket per IP/user; error shape match `libs/errorResponse.ts`); `internal/api/auth.go` — `/api/auth/{login,logout,me,setup,devices,approvals,login/pending/{id}}`.
- **Accept**: contract verify pass; 429 body shape match Next; `/me` JSON identical (user fields, approval flags).

### S15 — Git ops + worktrees (1.5)
- **Phase**: 1 · **Task ID**: 1.5 · **Depends**: S14 · **Effort**: 3-4h
- **Scope**: `libs/git.ts`, `worktrees.ts` → `internal/git/`. Lifecycle hook: `branchMode` (current/fixed/auto-create) → spawn → wait → `autoCommit` → `autoPush`. Failures log nhưng KHÔNG flip status.
- **Accept**: integration test với repo tmp; lifecycle order đúng theo `bridge.json` flags.

**🏁 Phase 1 gate**: bật `next.config.js` rewrites cho mọi endpoint phase 1 sang `:8080`; UI Next vẫn chạy bình thường ở `:7777`; smoke test create/spawn/kill/archive xanh.

---

## Phase 2 — Apps & Repos (6 session, parallel với Phase 3)

### S16 — Apps & detect (2.1)
- **Phase**: 2 · **Task ID**: 2.1 · **Depends**: S15 · **Effort**: 5-6h
- **Scope**: `libs/detect/*`, `scanApp.ts` → `internal/detect/`. Endpoints `/api/apps*`, `/api/apps/:name/{memory,scan}`, `/api/detect/{scan-roots,settings}`.
- **Accept**: contract verify pass; auto-detect dialog UI Next hoạt động qua Go backend.

### S17 — Repos API (2.2)
- **Phase**: 2 · **Task ID**: 2.2 · **Depends**: S16 · **Effort**: 4-5h
- **Scope**: `libs/repos.ts`, `repoProfile.ts`, `repoHeuristic.ts` → `internal/repos/`. Endpoints `/api/repos*`, `/api/repos/:name/{files,raw,slash-commands}`, `/api/repos/profiles*`.
- **Accept**: contract verify pass.

### S18 — Slash discovery (2.3)
- **Phase**: 2 · **Task ID**: 2.3 · **Depends**: S17 · **Effort**: 2-3h
- **Scope**: `libs/claudeSlashDiscovery.ts`, `claudeBuiltinSlash.ts` → `internal/slash/`. Internal use, được gọi từ S17.

### S19 — Memory & context (2.4)
- **Phase**: 2 · **Task ID**: 2.4 · **Depends**: S18 · **Effort**: 4-5h
- **Scope**: `libs/{memory,memoryDistill,pinnedFiles,contextAttach,resumePrompt,recentDirection}.ts` → `internal/memory/` + `internal/context/`. Gắn vào tasks/sessions.

### S20 — Quality gate (2.5)
- **Phase**: 2 · **Task ID**: 2.5 · **Depends**: S19 · **Effort**: 4-5h
- **Scope**: `libs/{qualityGate,validate,styleFingerprint,houseRules,playbooks,promptStore}.ts` → `internal/quality/`. Internal use.

### S21 — Symbol index (2.6)
- **Phase**: 2 · **Task ID**: 2.6 · **Depends**: S20 · **Effort**: 5-6h ⚠️ CGO
- **Scope**: `libs/symbolIndex.ts` → `internal/symbol/` dùng `github.com/smacker/go-tree-sitter`. **Fallback**: shell-out `tree-sitter` CLI nếu CGO blocker.
- **Accept**: index 1 repo demo, query symbol khớp Next output.

**🏁 Phase 2 gate**: contract test pass; auto-detect dialog UI hoạt động qua Go.

---

## Phase 3 — Telegram (4 session, parallel Phase 2)

### S22 — Telegram PoC (3.1) ⚠️ rủi ro nhất
- **Phase**: 3 · **Task ID**: 3.1 (§6.6 phase A) · **Depends**: S04 (không cần phase 1/2) · **Effort**: 1-3 ngày
- **Pre-req**: có `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, số điện thoại nhận SMS test (cần user thật, KHÔNG tự động được).
- **Scope**: chương trình `cmd/telegram-poc/main.go` dùng `gotd/td` — login phone+code+2FA, lưu session `.bridge-state/telegram-go.session`, gửi 1 message, đọc 1 update.
- **Accept**: round-trip 1 message trên tài khoản test.
- **Fallback gate**: nếu sau 3 ngày work không pass, mở task `3.5-fallback`: giữ Telegram Node trong `telegram-bridge/` sidecar, Go shell-out qua HTTP nội bộ. Update plan + escalate.

### S23 — Telegram client port (3.2)
- **Phase**: 3 · **Task ID**: 3.2 · **Depends**: S22 (PoC pass) · **Effort**: 5-7h
- **Scope**: `libs/telegramChatForwarder.ts`, `telegramIntent.ts` → `internal/telegram/{client.go,intent.go}`. Endpoints `/api/telegram/{settings,test}`, `/api/telegram/user/{settings,test}`.
- **Accept**: forwarder post session events tới chat; contract verify pass.

### S24 — Telegram CLI subcommands (3.3)
- **Phase**: 3 · **Task ID**: 3.3 · **Depends**: S23 · **Effort**: 3-4h
- **Scope**: `cmd/bridge/{telegram_login.go,approve_login.go}` cobra subcommand thay `scripts/telegram-login.ts`, `scripts/approve-login.ts`.
- **Accept**: `bridge telegram-login` interactive flow; `bridge approve-login <id>` đúng semantics.

### S25 — Telegram pattern matchers (3.4)
- **Phase**: 3 · **Task ID**: 3.4 · **Depends**: S23 · **Effort**: 3-4h
- **Scope**: port test cases `__tests__/telegramCommands.test.ts` + `telegramImportantPatterns.test.ts` sang Go testify table test.
- **Accept**: case count parity, all pass; lệnh `/status`, `/runs` qua Telegram thật trả đúng task list.

**🏁 Phase 3 gate**: gửi/nhận message + `/status` `/runs` qua Go giống Node.

---

## Phase 4 — Tunnels & misc (4 session)

### S26 — Tunnels (4.1)
- **Phase**: 4 · **Task ID**: 4.1 · **Depends**: S15 · **Effort**: 4-5h
- **Scope**: `app/api/tunnels/**` → `internal/tunnels/`. Endpoints `/api/tunnels*`, `/api/tunnels/providers/ngrok/{install,authtoken}`. Manage ngrok process.
- **Accept**: contract verify; install/authtoken/start/stop ngrok hoạt động.

### S27 — Upload (4.2)
- **Phase**: 4 · **Task ID**: 4.2 · **Depends**: S15 · **Effort**: 2-3h
- **Scope**: `libs/uploadGuards.ts` → `internal/upload/`. Endpoints `POST /api/sessions/:id/upload`, `GET /api/uploads/:sid/:name`.
- **Accept**: contract verify (multipart hash so sánh, không byte raw).

### S28 — Permission stream (4.3)
- **Phase**: 4 · **Task ID**: 4.3 · **Depends**: S15 · **Effort**: 4-5h
- **Scope**: `/api/permission*`, `/api/permission/stream` (SSE event `permission.request`), `/api/sessions/:id/permission*`.
- **Accept**: SSE framing match; contract verify pass.

### S29 — Misc routes (4.4)
- **Phase**: 4 · **Task ID**: 4.4 · **Depends**: S26+S27+S28 · **Effort**: 3-4h
- **Scope**: `app/api/bridge/settings`, `app/api/sessions/:id/{tail,kill,rewind,message}`. Cleanup mọi route lẻ còn lại.
- **Accept**: contract verify cho **toàn bộ 65/65 endpoint**; `next.config.js` rewrites toàn diện sang `:8080`.

**🏁 Phase 4 gate**: 65/65 endpoint pass contract test; UI Next ăn 100% từ Go backend; Next chỉ còn vai trò render UI.

---

## Phase 5 — Frontend Vite SPA (7 session, parallel Phase 4)

### S30 — Vite scaffold + config (5.1+5.2)
- **Phase**: 5 · **Task ID**: 5.1+5.2 (§6.7 part 1) · **Depends**: S04 (chỉ cần OpenAPI) · **Effort**: 4-5h
- **Scope**: `web/` Vite 5 + React 19 + TS strict + Tailwind 4 + PostCSS + ESLint. `vite.config.ts` proxy `/api` → `:8080`, alias `@/`. Reuse `tailwind.config` từ Next.
- **Accept**: `pnpm --filter web dev` boot ở `:5173`, render hello world; TS strict + ESLint clean.

### S31 — Routing + theme + boot (5.3 partA + 5.7 + 5.8)
- **Phase**: 5 · **Task ID**: 5.3 + 5.7 + 5.8 · **Depends**: S30 · **Effort**: 4-5h
- **Scope**: TanStack Router file-based, 10 route declarations (chưa cần page nội dung); ThemeProvider/Confirm/Toasts (port `app/_components/Providers.tsx`); `@fontsource/<font>` thay `next/font`; auth boot `GET /api/auth/me` → redirect `/login` nếu 401.
- **Accept**: navigate giữa route không full reload; theme switch work.

### S32 — TS API client + lib (5.4 + 5.6)
- **Phase**: 5 · **Task ID**: 5.4 + 5.6 · **Depends**: S31 · **Effort**: 3-4h
- **Scope**: `web/src/api/client.ts` từ `openapi-typescript` + `openapi-fetch`; port `libs/client/*` → `web/src/lib/*`.
- **Accept**: 1 query test gọi `/api/tasks/meta` qua TanStack Query → render JSON.

### S33 — Pages 1-3: Home, TasksList, TaskDetail (5.3 partB)
- **Phase**: 5 · **Task ID**: 5.3 (§6.7 part 2) · **Depends**: S32 · **Effort**: 5-6h
- **Scope**: port `app/page.tsx`, `app/tasks/page.tsx`, `app/tasks/[id]/page.tsx`. Replace `next/link`→`<Link>`, `next/navigation`→`useNavigate/useSearch`, `next/image`→`<img>`.
- **Accept**: Playwright screenshot diff <2% vs Next baseline (light + dark).

### S34 — Pages 4-7: Sessions/Apps/Usage/Tunnels (5.3 partC)
- **Phase**: 5 · **Task ID**: 5.3 · **Depends**: S33 · **Effort**: 5-6h
- **Scope**: port 4 page tương ứng.
- **Accept**: screenshot diff <2% mỗi page.

### S35 — Pages 8-10: Settings, Login, Docs (5.3 partD) + Components (5.5)
- **Phase**: 5 · **Task ID**: 5.3 + 5.5 · **Depends**: S34 · **Effort**: 5-6h
- **Scope**: port 3 page cuối + `app/_components/**` → `web/src/components/**` (đa số chỉ thay import path).
- **Accept**: screenshot diff <2%; keyboard shortcut (cmd-k command palette), drag-drop, paste image, mention picker chạy.

### S36 — Visual parity full (5.9)
- **Phase**: 5 · **Task ID**: 5.9 · **Depends**: S35 · **Effort**: 4-5h
- **Scope**: Playwright snapshot 10 page × 2 theme. Lock font version, chạy diff trên Linux runner cho ổn định.
- **Accept**: 20 snapshot diff <2% — record failures vào `summary.md PLAN-FIXUP:` nếu cần plan update.

**🏁 Phase 5 gate**: `web/dist/` build static; mở trực tiếp `dist/index.html` (proxy API qua Go) UI đầy đủ.

---

## Phase 6 — Embed & cutover (3 session)

### S37 — Embed pipeline + binary (6.1 + 6.2)
- **Phase**: 6 · **Task ID**: 6.1 + 6.2 · **Depends**: S29 + S36 (cần cả backend full + frontend full) · **Effort**: 4-5h
- **Scope**: Go `embed.FS` cho `web/dist`, SPA fallback handler (route không match `/api/*` → trả `index.html`). `make build` cross-compile 6 platform: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64, windows/arm64. Binary <50MB.
- **Accept**: 6 binary build OK; chạy `./bridge serve --port 7777`, mở browser `:7777` thấy UI đầy đủ.

### S38 — Migration script + cutover switch (6.3 + 6.4)
- **Phase**: 6 · **Task ID**: 6.3 + 6.4 · **Depends**: S37 · **Effort**: 3-4h
- **Scope**: migration script copy `bridge.json` + `sessions/` không đổi. Nếu cookie format khác (S13 chọn option B), force re-login + ghi `RELEASE_NOTES.md`. Switch `bridge serve` bind `:7777` (đổi từ `:8080`), tắt Next dev server.
- **Accept**: chạy `./bridge serve` ở `:7777`, không có Next, mọi flow UI hoạt động.

### S39 — Cleanup Node + docs (6.5 + 6.6 + 6.7)
- **Phase**: 6 · **Task ID**: 6.5 + 6.6 + 6.7 · **Depends**: S38 · **Effort**: 3-4h
- **Scope**: xóa `app/`, `libs/` (ở root, KHÔNG xóa `web/src/lib`), `package.json` root (giữ `web/package.json`), `node_modules/`. Cập nhật `CLAUDE.md` (`bun dev` → `make dev`/`./bridge serve`, snippet self-register), `BRIDGE.md`, `prompts/coordinator.md`.
- **Accept**: repo không còn Node ở root; `make dev` boot Go + Vite proxy; CLAUDE.md hướng dẫn đúng.

**🏁 Phase 6 gate**: 1 binary trên máy mới không có Node, UI + mọi flow hoạt động đầy đủ.

---

## Phase 7 — Hardening (3 session)

### S40 — Test rewrite + load test (7.1)
- **Phase**: 7 · **Task ID**: 7.1 · **Depends**: S39 · **Effort**: 6-8h
- **Scope**: rà soát 50 file Vitest, đảm bảo có equivalent Go testify (case count parity). `k6` script load `/api/tasks/meta` 100 RPS, baseline so sánh Next pre-cutover.
- **Accept**: `go test ./...` xanh; k6 p99 ≤ baseline Next.

### S41 — E2E full + parity bug fix (7.2 + 7.3)
- **Phase**: 7 · **Task ID**: 7.2 + 7.3 · **Depends**: S40 · **Effort**: 5-7h
- **Scope**: Playwright full suite chạy Windows + Linux runner. Fix mọi parity issue được phát hiện (SSE quirk, header, cookie, font subpixel).
- **Accept**: 0 open parity bug; SLO đạt — RAM idle <50MB, p99 <50ms, cold start <300ms.

### S42 — Release v1.0.0-go (7.4)
- **Phase**: 7 · **Task ID**: 7.4 · **Depends**: S41 · **Effort**: 3-4h
- **Scope**: `RELEASE_NOTES.md` đầy đủ entry cookie/format change (nếu có); `CHANGELOG.md`; binary upload 6 platform; docs migrate. Merge `migration/go` → `main`.
- **Accept**: Definition of Done §9 tick hết; tag `v1.0.0-go`.

---

## Tổng kết

| Phase | Session | Effort total | Critical path |
|---|---|---|---|
| 0 | S01-S04 | 11-15h | tuần 1 |
| 1 | S05-S15 | 39-51h | tuần 2-3 |
| 2 | S16-S21 | 24-30h | tuần 4 (parallel 3) |
| 3 | S22-S25 | 13-21h + PoC 1-3 ngày | tuần 4-5 (parallel 2) |
| 4 | S26-S29 | 13-17h | tuần 5 |
| 5 | S30-S36 | 30-37h | tuần 5-6 (parallel 4) |
| 6 | S37-S39 | 10-13h | tuần 6 |
| 7 | S40-S42 | 14-19h | tuần 7 |
| **Tổng** | **42 session** | **~150-200h** | **5-7 tuần** |

## Verify parity (KHÔNG dùng `git diff main`)

Sau khi xong S42, **đừng** so sánh nhánh `migration/go` với `main` để verify feature — diff sẽ là toàn bộ codebase. Verify bằng:

1. **Contract test**: `make contract` — 65 endpoint Go vs Next golden bytewise.
2. **Playwright visual diff**: 10 page × 2 theme, diff <2% so với Next baseline đã capture trước cutover.
3. **Smoke checklist** (manual): create task → spawn 2 agent song song → kill 1 → archive → forwarder Telegram báo đúng. Đối chiếu với clip màn hình Next pre-cutover.
4. **Test parity**: `go test ./...` count cases ≥ 50 file Vitest gốc; mọi case Vitest có Go equivalent.
5. **SLO check**: RAM idle, p99 latency, cold start đạt §0 TL;DR.

Diff `main` chỉ hữu ích cho **review từng PR** trong nhánh `migration/go` (xem session đó đụng file nào), không phải để verify feature parity.
