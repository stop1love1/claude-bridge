# Migration Plan — claude-bridge: Next.js → Go

> Tài liệu này là **playbook orchestration** để migrate toàn bộ `claude-bridge` từ Next.js (Bun + Node) sang **Go single binary embed Vite SPA**, **giữ nguyên 100% UI/UX và feature** hiện tại.
>
> Đối tượng đọc: coordinator agent + sub-agent triển khai. Mọi prompt trong file này có thể paste thẳng cho `claude -p` (qua `POST /api/tasks/<id>/agents`).

---

## 0. TL;DR

| Mục | Trạng thái đích |
|---|---|
| **Backend** | Go 1.23+, `chi` router, single binary |
| **Frontend** | Vite 5 + React 19 + Tailwind 4 + TanStack Router (port từ Next App Router) |
| **Deploy** | 1 binary `bridge` (~15-25 MB), embed UI qua `embed.FS`, 1 port (7777) |
| **Type contract FE↔BE** | OpenAPI 3.1 + `oapi-codegen` (Go) + `openapi-typescript` (TS) |
| **Effort ước tính** | 5-7 tuần full-time, đi theo **strangler-fig** từng domain |
| **Bất biến** | Cookie format, JSON schema, URL path, SSE event name, file format trên disk (`bridge.json`, `meta.json`, `*.jsonl`) — KHÔNG đổi |

---

## 1. Mục tiêu & Phi-mục-tiêu

### Mục tiêu (must)
1. **Parity tuyệt đối**: tất cả 65 route, 10 page, ~50 component, 50 test phải có hành vi tương đương — người dùng không cảm nhận được sự thay đổi nào trong UI/UX.
2. **Format dữ liệu trên disk không đổi**: `bridge.json`, `sessions/<id>/meta.json`, `summary.md`, `*.jsonl` đọc được bởi cả Next cũ và Go mới (cho phép rollback an toàn).
3. **Single binary, single port**: `./bridge serve` chạy ở `:7777`, embed cả UI lẫn API.
4. **Hiệu năng**: cold start <300ms, RAM idle <50MB, p99 API latency <50ms cho route đọc thuần file.
5. **Test parity**: contract test (golden response) chạy được với cả 2 implementation, kết quả giống bytewise.

### Phi-mục-tiêu (won't)
- Refactor business logic — port nguyên si, không "cải thiện trên đường đi".
- Đổi schema DB/disk — bất kỳ thay đổi format nào phải có migration script riêng và đi sau khi cutover xong.
- Thay design system — Radix + Tailwind 4 giữ y nguyên, chỉ thay layer routing/SSR.

---

## 2. Kiến trúc đích

```
claude-bridge/
├── cmd/bridge/             # Go entrypoint (cobra CLI)
│   └── main.go             # subcommands: serve, telegram-login, set-password, approve-login
├── internal/
│   ├── server/             # HTTP server (chi router, middleware)
│   ├── api/                # Handlers (1 file/domain)
│   │   ├── tasks.go
│   │   ├── sessions.go
│   │   ├── apps.go
│   │   ├── repos.go
│   │   ├── auth.go
│   │   ├── tunnels.go
│   │   ├── telegram.go
│   │   ├── permission.go
│   │   ├── upload.go
│   │   └── usage.go
│   ├── spawn/              # claude -p subprocess engine
│   ├── sessions/           # JSONL parser, usage stats
│   ├── meta/               # meta.json read/write atomic
│   ├── git/                # git ops + worktrees
│   ├── auth/               # bcrypt, cookies, login approvals
│   ├── detect/             # app heuristic + LLM detect
│   ├── telegram/           # gotd/td MTProto wrapper
│   ├── tunnels/            # ngrok manager
│   ├── permission/         # SSE permission flow
│   ├── memory/             # CLAUDE.md distill
│   ├── quality/            # quality gate, validate, style
│   ├── symbol/             # tree-sitter index
│   └── config/             # bridge.json, env, paths
├── web/                    # Vite SPA (replaces app/)
│   ├── src/
│   │   ├── pages/          # 10 pages
│   │   ├── components/     # ~50 components (port nguyên từ app/_components)
│   │   ├── lib/            # client utils (port từ libs/client)
│   │   ├── api/            # generated TS client từ OpenAPI
│   │   └── main.tsx
│   ├── index.html
│   └── vite.config.ts
├── api/openapi.yaml        # source of truth cho FE↔BE contract
├── sessions/               # KHÔNG ĐỔI — Go đọc/ghi cùng format
├── prompts/                # KHÔNG ĐỔI — coordinator/playbook reuse được
├── bridge.json             # KHÔNG ĐỔI
├── go.mod
├── package.json            # chỉ còn cho web/, sau cutover xóa
└── Makefile                # build, test, embed pipeline
```

### Strangler-fig flow

```
[Browser :7777] ──▶ [Next.js dev server :7777]
                          │
                          │ next.config.js rewrites: /api/sessions/* /api/tasks/* …
                          ▼
                    [Go server :8080]  ◀── khi route đã port xong, bật rewrite
                          │
                          ▼
                    [filesystem, child claude -p, telegram MTProto]
```

Cutover cuối: Next biến mất, Go server bind thẳng `:7777`, embed UI build sẵn.

---

## 3. Parity Rules (BẤT BIẾN — vi phạm = task fail)

> Mỗi PR phải tự xác nhận tuân thủ trong description. Reviewer kiểm tra theo checklist này.

1. **URL paths**: giữ y hệt `app/api/...` mapping (ví dụ `GET /api/tasks/:id` → `GET /api/tasks/{id}`).
2. **HTTP methods + status codes**: 200/201/204/400/401/403/404/409/422/500 — match Next handler hiện tại.
3. **Response body**:
   - JSON shape (key names, casing, nested structure) phải bytewise identical sau `json.Marshal` + `JSON.stringify` cùng input.
   - Field optional vs null vs undefined: nếu Next trả `undefined` (key vắng mặt), Go phải dùng `omitempty`.
4. **Headers**:
   - `Set-Cookie` name/path/domain/SameSite/Secure/HttpOnly khớp byte (cookie session, CSRF).
   - `Cache-Control`, `Content-Type` (đặc biệt `text/event-stream` cho SSE).
   - Custom: `x-bridge-internal-token`, `x-task-id`, `x-session-id` — giữ tên.
5. **SSE**:
   - Event names: `permission.request`, `session.tail`, `task.event`, `agent.detect.progress` — không đổi.
   - Payload: cùng JSON shape, cùng `data:` framing, ping interval ≤30s.
6. **Cookies/auth**:
   - Tên cookie: `bridge_session`, `bridge_setup` — giữ.
   - Format: `iron-session` style (Next) → cần lib Go tương thích HOẶC migrate format trong cùng release với clear-cookie + re-login (ghi rõ trong RELEASE_NOTES).
7. **File format trên disk**: nguyên si.
8. **CLI args, env vars** (`BRIDGE_INTERNAL_TOKEN`, `BRIDGE_ALLOW_BYPASS`, …): giữ tên, semantics.
9. **UI**:
   - Pixel parity: trước/sau migrate, screenshot Playwright của 10 page phải diff <2% (do font subpixel).
   - Keyboard shortcut, drag-drop, paste image, mention picker — hành vi giữ.
   - Theme dark/light, command palette, toast — không thay đổi.
10. **Process semantics**:
    - Spawn `claude -p` với cùng args, cùng env.
    - Kill cây con: Windows job object, POSIX pgid — child phải chết hết khi parent chết.
    - Lifecycle hook git (commit/push) chạy đúng thứ tự, tôn trọng `bridge.json` flags.

---

## 4. Roles & Agents

| Agent | Phụ trách | Skills cần |
|---|---|---|
| `coordinator` | Điều phối phase, theo dõi tiến độ, dispatch sub-agents qua `POST /api/tasks/<id>/agents`, cập nhật `summary.md` | đọc plan, viết prompt, không code |
| `architect-go` | Thiết kế Go module layout, OpenAPI spec, contract test framework, scaffold project | Go architecture, OpenAPI, codegen |
| `backend-go-core` | Port server, spawn engine, session reader, meta atomic write, auth, permission, git ops | Go, `os/exec`, `fsnotify`, bcrypt |
| `backend-go-detect` | Port `libs/detect/*`, `scanApp.ts`, `repoHeuristic.ts`, `repoProfile.ts`, `slashDiscovery.ts`, memory, quality, symbol-index | Go, LLM HTTP, tree-sitter |
| `backend-go-telegram` | Port Telegram bridge sang `gotd/td`, gồm cả 3 scripts CLI | Go, MTProto, gotd/td SDK |
| `backend-go-tunnels` | Port tunnels/ngrok, install/authtoken | Go, ngrok process management |
| `frontend-vite` | Khởi tạo Vite SPA, port 10 page + ~50 component, thay routing, generate TS client từ OpenAPI | React 19, Vite, TanStack Router, Tailwind 4 |
| `test-go` | Rewrite 50 Vitest sang Go testing + `testify`, viết contract test framework | Go testing, table-driven tests |
| `qa-parity` | Build parity diff tool, chạy E2E Playwright song song Next + Go, tìm regression | Playwright, golden tests |
| `devops` | Build pipeline (`Makefile`, embed, cross-compile), CI workflow, dev hot-reload (`air` + `vite`) | Go build, GitHub Actions, Vite |
| `reviewer` | Review từng PR theo Parity Rules §3, block nếu vi phạm | đọc code Go + TS |

**Quy tắc spawn**: mọi sub-agent đều spawn qua `POST /api/tasks/<id>/agents` (không dùng `Task` tool), tự register session theo CLAUDE.md.

---

## 5. Phases (sequential gates)

Mỗi phase chỉ sang phase kế khi **gate** thỏa mãn. Trong cùng phase, các task có thể parallel nếu không chia sẻ file.

### Phase 0 — Foundation (1 tuần) — `architect-go` + `devops`

| Task | Owner | Output |
|---|---|---|
| 0.1 | `architect-go` | `api/openapi.yaml` v0.1: scaffold tất cả 65 endpoint với path + method, body schema để TBD |
| 0.2 | `architect-go` | `cmd/bridge/main.go` + `internal/server/server.go` chạy được `./bridge serve` ở `:8080`, trả `{"status":"ok"}` cho `/api/health` |
| 0.3 | `architect-go` | Module skeleton `internal/{api,spawn,sessions,…}` với interface stub |
| 0.4 | `devops` | `Makefile`: `make dev` (air + vite proxy), `make build` (vite build → embed → go build), `make test` |
| 0.5 | `devops` | `.github/workflows/go.yml`: lint (`golangci-lint`), test, build matrix Windows/Linux/macOS |
| 0.6 | `architect-go` | Contract test framework: chạy 1 request lên Next, ghi response → golden file; cùng request lên Go, diff |
| 0.7 | `test-go` | Helper test: `t.TempDir()` cho FS, fake `claude` CLI binary cho spawn test |

**Gate**: `make build` thành công, contract test framework chạy được với 1 endpoint pilot (`GET /api/tasks/meta`), CI xanh.

---

### Phase 1 — Core domain (1.5 tuần) — `backend-go-core`

Port nhóm endpoint quan trọng nhất, chiếm 70% traffic của UI.

| Task | Owner | Files Next → Go | Endpoints |
|---|---|---|---|
| 1.1 | `backend-go-core` | `libs/sessions.ts`, `sessionEvents.ts`, `sessionListCache.ts`, `sessionUsage.ts`, `usageStats.ts` → `internal/sessions/`, `internal/usage/` | `GET /api/sessions`, `GET /api/sessions/all`, `GET /api/sessions/:id`, `GET /api/usage`, `GET /api/tasks/:id/usage` |
| 1.2 | `backend-go-core` | `libs/spawn.ts`, `spawnRegistry.ts`, `processKill.ts`, `retrySpawn.ts`, `childRetry.ts`, `staleRunReaper.ts`, `shutdownHandler.ts`, `inFlight.ts` → `internal/spawn/` | nội bộ — không endpoint trực tiếp, dùng cho 1.3 |
| 1.3 | `backend-go-core` | Task lifecycle: `app/api/tasks/**` (~15 endpoint) | `GET/POST/PATCH/DELETE /api/tasks*`, `POST /api/tasks/:id/agents`, `POST /api/tasks/:id/link`, `/clear`, `/summary`, `/meta`, `/events` (SSE), `/continue`, `/runs/:sid/{kill,prompt,diff}` |
| 1.4 | `backend-go-core` | `libs/auth.ts`, `setupToken.ts`, `loginApprovals.ts`, `permissionSettings.ts`, `rateLimit.ts`, `errorResponse.ts` → `internal/auth/`, `internal/middleware/` | `/api/auth/{login,logout,me,setup,devices,approvals,login/pending}` |
| 1.5 | `backend-go-core` | `libs/git.ts`, `worktrees.ts` → `internal/git/` | nội bộ — lifecycle hook |

**Gate**:
- Contract test pass cho toàn bộ endpoint trong phase.
- `next.config.js` rewrites trỏ tất cả endpoint phase 1 sang Go (`:8080`), UI Next vẫn chạy bình thường ở `:7777`.
- Smoke test thủ công: tạo task, spawn agent, xem live log, kill, archive — tất cả qua UI Next.

---

### Phase 2 — Apps & Repos (1 tuần) — `backend-go-detect`

| Task | Owner | Files | Endpoints |
|---|---|---|---|
| 2.1 | `backend-go-detect` | `libs/detect/*`, `scanApp.ts` → `internal/detect/` | `/api/apps*`, `/api/apps/:name/{memory,scan}`, `/api/detect/{scan-roots,settings}` |
| 2.2 | `backend-go-detect` | `libs/repos.ts`, `repoProfile.ts`, `repoHeuristic.ts` → `internal/repos/` | `/api/repos*`, `/api/repos/:name/{files,raw,slash-commands}`, `/api/repos/profiles*` |
| 2.3 | `backend-go-detect` | `libs/claudeSlashDiscovery.ts`, `claudeBuiltinSlash.ts` → `internal/slash/` | (dùng nội bộ trong 2.2) |
| 2.4 | `backend-go-detect` | `libs/memory.ts`, `memoryDistill.ts`, `pinnedFiles.ts`, `contextAttach.ts`, `resumePrompt.ts`, `recentDirection.ts` → `internal/memory/`, `internal/context/` | (gắn vào tasks/sessions) |
| 2.5 | `backend-go-detect` | `libs/qualityGate.ts`, `validate.ts`, `styleFingerprint.ts`, `houseRules.ts`, `playbooks.ts`, `promptStore.ts` → `internal/quality/` | nội bộ |
| 2.6 | `backend-go-detect` | `libs/symbolIndex.ts` → `internal/symbol/` (tree-sitter Go bindings) | nội bộ |

**Gate**: contract test pass; auto-detect dialog trong UI hoạt động qua Go backend.

---

### Phase 3 — Telegram MTProto (1.5-2 tuần — chạy SONG SONG với Phase 2) — `backend-go-telegram`

> Đây là phần rủi ro nhất. Bắt đầu **PoC ngày đầu** — nếu sau 3 ngày không login được, rút sang fallback (giữ Telegram bridge ở Node, Go shell-out hoặc gRPC sang Node helper).

| Task | Owner | Files | Endpoints |
|---|---|---|---|
| 3.1 | `backend-go-telegram` | PoC `gotd/td`: login (phone + code + 2FA), session storage (file/SQLite), gửi/nhận 1 tin | — |
| 3.2 | `backend-go-telegram` | `libs/telegramChatForwarder.ts`, `telegramIntent.ts` → `internal/telegram/` | `/api/telegram/{settings,test}`, `/api/telegram/user/{settings,test}` |
| 3.3 | `backend-go-telegram` | Scripts: port `scripts/telegram-login.ts` → `bridge telegram-login` cobra subcommand | CLI |
| 3.4 | `backend-go-telegram` | Command parser, important pattern matcher (port từ `__tests__/telegramCommands.test.ts`, `telegramImportantPatterns.test.ts`) | nội bộ |

**Gate**: gửi/nhận message Telegram, command `/status` `/runs` qua Go backend giống Node hiện tại.

**Fallback nếu PoC fail**: giữ `app/api/telegram/**` ở Node trong file `telegram-bridge/` riêng, Go shell-out qua HTTP nội bộ. Document cụ thể trong release notes.

---

### Phase 4 — Tunnels & misc (3-5 ngày) — `backend-go-tunnels`

| Task | Owner | Files | Endpoints |
|---|---|---|---|
| 4.1 | `backend-go-tunnels` | `app/api/tunnels/**` (~5 endpoint), ngrok install/authtoken | `/api/tunnels*`, `/api/tunnels/providers/ngrok/{install,authtoken}` |
| 4.2 | `backend-go-core` | `libs/uploadGuards.ts` → `internal/upload/` | `POST /api/sessions/:id/upload`, `GET /api/uploads/:sid/:name` |
| 4.3 | `backend-go-core` | Permission stream | `GET/POST /api/permission`, `/api/permission/stream` (SSE), `/api/sessions/:id/permission*` |
| 4.4 | `backend-go-core` | `app/api/bridge/settings`, `app/api/sessions/:id/{tail,kill,rewind,message}` còn lại | (cleanup các route lẻ) |

**Gate**: 65/65 endpoint đã có version Go pass contract test, `next.config.js` rewrites toàn bộ.

---

### Phase 5 — Frontend Vite SPA (1.5 tuần) — `frontend-vite`

> Chạy **song song** với Phase 4 (cả hai không đụng nhau).

| Task | Owner | Output |
|---|---|---|
| 5.1 | `frontend-vite` | `web/` scaffold: Vite 5 + React 19 + TS strict + Tailwind 4 + PostCSS + ESLint |
| 5.2 | `frontend-vite` | `web/vite.config.ts`: dev proxy `/api` → `http://localhost:8080`, alias `@/` cho `web/src` |
| 5.3 | `frontend-vite` | TanStack Router setup, port 10 route từ Next App Router (giữ URL: `/`, `/tasks`, `/tasks/:id`, `/sessions`, `/apps`, `/usage`, `/tunnels`, `/settings`, `/login`, `/docs`) |
| 5.4 | `frontend-vite` | Generate `web/src/api/client.ts` từ `api/openapi.yaml` qua `openapi-typescript` + `openapi-fetch` |
| 5.5 | `frontend-vite` | Port `app/_components/**` → `web/src/components/**` (đa số chỉ thay import path, vài chỗ thay `next/link` → `<Link>` của router) |
| 5.6 | `frontend-vite` | Port `libs/client/*` → `web/src/lib/*` |
| 5.7 | `frontend-vite` | Theme provider, font (`@fontsource` thay `next/font`), favicon, manifest |
| 5.8 | `frontend-vite` | Cookie/auth boot: `GET /api/auth/me` lúc khởi động, redirect `/login` nếu 401 |
| 5.9 | `qa-parity` | Playwright snapshot test 10 page (light + dark) — diff <2% |

**Gate**: `web/dist/` build ra static, mở trực tiếp file dist (không cần Next) UI hoạt động đầy đủ.

---

### Phase 6 — Embed & cutover (3-5 ngày) — `devops` + `coordinator`

| Task | Owner | Output |
|---|---|---|
| 6.1 | `devops` | Go `embed.FS` cho `web/dist`, SPA fallback handler |
| 6.2 | `devops` | Build `make build` produce `bridge` binary <50MB, cross-compile 6 platform |
| 6.3 | `devops` | Migration script: copy `bridge.json` + `sessions/` không đổi; nếu cookie format khác, force re-login (ghi RELEASE_NOTES) |
| 6.4 | `coordinator` | Switch `bridge serve` bind `:7777`, tắt Next dev server |
| 6.5 | `coordinator` | Xóa `app/`, `libs/` (Node), `package.json` ở root (giữ `web/package.json`), `node_modules/` |
| 6.6 | `coordinator` | Cập nhật `CLAUDE.md`: thay `bun dev` → `make dev` hoặc `./bridge serve`, sửa snippet self-register nếu đổi port nội bộ |
| 6.7 | `coordinator` | Cập nhật `prompts/coordinator.md`, `BRIDGE.md` |

**Gate**: Một binary `./bridge` ở máy mới, không có Node, UI hoạt động đầy đủ, mọi feature flow chạy được.

---

### Phase 7 — Hardening & perf (1 tuần) — `qa-parity` + `backend-go-core`

| Task | Owner | Output |
|---|---|---|
| 7.1 | `qa-parity` | Chạy bộ 50 test rewrite Go pass; load test với `k6` 100 RPS lên `/api/tasks/meta` (so với Next baseline) |
| 7.2 | `qa-parity` | E2E Playwright full suite, cả Windows + Linux |
| 7.3 | `backend-go-core` | Fix mọi parity issue được phát hiện |
| 7.4 | `devops` | Release v1.0.0-go: changelog, binary upload, docs migrate |

**Gate**: SLO đạt (RAM <50MB idle, p99 <50ms, cold start <300ms), không còn open parity bug.

---

## 6. Per-task Prompts (paste cho `claude -p`)

> Mỗi prompt đã chứa: context, task scope, ràng buộc parity, deliverables, acceptance test. Bridge tự inject `BRIDGE_INTERNAL_TOKEN`, task ID, app cwd.

### 6.0 Coordinator boot prompt

```
You are the migration coordinator for claude-bridge Next→Go.

Read MIGRATION_GO.md at repo root. Current phase: <PHASE>.

Your job:
1. List tasks in this phase that are unblocked (deps satisfied).
2. For each, dispatch a sub-agent via POST /api/tasks/<task-id>/agents
   using the prompt template in MIGRATION_GO.md §6.<task-id>.
3. Track status in sessions/<task-id>/summary.md — top line stays
   READY FOR REVIEW only when ALL phase tasks pass their acceptance.
4. Do NOT use the Task tool. Do NOT cd into other repos. Do NOT
   git commit/push (bridge handles that).
5. Block on phase gate before scheduling next phase.

Parity rules in §3 are non-negotiable. Reject any sub-agent output
that violates them and re-dispatch with corrective feedback.
```

### 6.1 — `architect-go`: scaffold Go server

```
ROLE: architect-go
TASK ID: 0.2 (see MIGRATION_GO.md §5 Phase 0)

CONTEXT
You are scaffolding the Go replacement for the Next.js backend of
claude-bridge. The existing app is at d:/Edusoft/claude-bridge with
65 API routes under app/api/. You don't migrate logic yet — only
build the empty server skeleton.

DELIVERABLES
1. cmd/bridge/main.go — cobra root command with subcommand `serve`
   that starts an HTTP server on :8080 (override via --port).
2. internal/server/server.go — chi router with:
   - Logger middleware (zerolog)
   - Recover middleware
   - CORS for http://localhost:7777 (Next still hosts UI in dev)
   - Cookie parser
3. GET /api/health → {"status":"ok","version":"<git sha>","uptime":<seconds>}
4. internal/{api,spawn,sessions,meta,git,auth,detect,telegram,
   tunnels,permission,memory,quality,symbol,config}/doc.go — empty
   package docs only.
5. go.mod with:
   - github.com/go-chi/chi/v5
   - github.com/spf13/cobra
   - github.com/rs/zerolog
6. Makefile targets: `make dev` (uses air), `make build`, `make test`.

CONSTRAINTS
- Go 1.23+ only.
- No external DB. State is filesystem.
- Do NOT touch app/ or libs/ — Node side stays running.
- Single binary, no CGO unless tree-sitter requires (defer that).

ACCEPTANCE
- `go run ./cmd/bridge serve --port 8080` starts cleanly.
- curl http://localhost:8080/api/health returns 200 + JSON above.
- `golangci-lint run ./...` clean.
- `go test ./...` passes (no tests yet, just compile).
```

### 6.2 — `architect-go`: OpenAPI scaffold

```
ROLE: architect-go
TASK ID: 0.1

CONTEXT
We need api/openapi.yaml as source-of-truth for all 65 endpoints in
app/api/**/route.ts so we can codegen Go server stubs and TS client.

DELIVERABLES
1. api/openapi.yaml v0.1 (OpenAPI 3.1) listing all 65 paths with:
   - HTTP method(s)
   - Path parameters (typed)
   - Query parameters (typed)
   - Request body schema (use "x-todo: true" if not yet inspected)
   - Response: 200/4xx with schema (placeholder ok)
   - operationId in lowerCamelCase, e.g. listTasks, getTaskById
2. Run: `openapi-typescript api/openapi.yaml -o web/src/api/schema.ts`
3. Run: `oapi-codegen -generate types,chi-server -package api
   api/openapi.yaml > internal/api/openapi_gen.go`
4. Verify both codegens succeed.

CONSTRAINTS
- Path-by-path mirror of app/api/. URL casing identical.
- Use $ref + components/schemas for shared types (Task, Session,
  Run, AppEntry, RepoProfile, ApiError).
- ApiError shape MUST match libs/errorResponse.ts current output:
  { error: string, code?: string, details?: object }

ACCEPTANCE
- 65 paths × correct methods present.
- Both codegens produce no errors.
- web/src/api/schema.ts compiles under TS strict.
```

### 6.3 — `backend-go-core`: spawn engine

```
ROLE: backend-go-core
TASK ID: 1.2

CONTEXT
Port the subprocess management layer. Source TS:
- libs/spawn.ts
- libs/spawnRegistry.ts
- libs/processKill.ts
- libs/retrySpawn.ts
- libs/childRetry.ts
- libs/staleRunReaper.ts
- libs/shutdownHandler.ts
- libs/inFlight.ts

Read each file before designing the Go API. The engine spawns
`claude -p` child processes per task, captures session ID from
stdout, tracks status in sessions/<task-id>/meta.json.

DELIVERABLES
internal/spawn/spawn.go with:
  type Engine struct { … }
  func New(cfg Config) *Engine
  func (e *Engine) Spawn(ctx context.Context, req SpawnRequest) (*Run, error)
  func (e *Engine) Kill(taskID, sessionID string) error
  func (e *Engine) ReapStale(ctx context.Context) error
  func (e *Engine) Shutdown() error  // SIGTERM all children, wait, SIGKILL fallback

internal/spawn/registry.go (in-memory map of running runs)
internal/spawn/process_kill_windows.go (job objects via golang.org/x/sys/windows)
internal/spawn/process_kill_unix.go (setpgid + killpg)
internal/spawn/retry.go (port retrySpawn ladder)

Tests in internal/spawn/spawn_test.go covering parity with
libs/__tests__/spawn.test.ts cases (use a fake `claude` binary
script in t.TempDir).

CONSTRAINTS
- Cross-platform: Windows job objects MUST kill grandchildren.
- Output capture: stdout/stderr stream into sessions/<task-id>/<session-id>.log
  and notify subscribers via channel (used later for SSE tail).
- Lifecycle hook order (per CLAUDE.md): branchMode → spawn → wait →
  autoCommit → autoPush. Hook failures logged but don't flip status.
- DO NOT run git ops here. Call internal/git/ via injected interface.

ACCEPTANCE
- Spawn fake-claude that prints "session: abc-123\nhello\n", verify:
  - Run record has SessionID="abc-123"
  - Log file contains both lines
  - Kill before exit cleans up child (no orphans, verified by ps test)
- Retry ladder triggers on exit code 1, gives up after N attempts.
- Stale reaper kills processes whose meta.json says running but PID gone.
```

### 6.4 — `backend-go-core`: tasks API

```
ROLE: backend-go-core
TASK ID: 1.3

CONTEXT
Port all task lifecycle endpoints. Source dir: app/api/tasks/.
Each route.ts becomes a Go handler matching the OpenAPI operationId.

ENDPOINTS (15)
GET    /api/tasks                  — list
POST   /api/tasks                  — create
GET    /api/tasks/meta             — bulk meta for all tasks
GET    /api/tasks/{id}             — detail
PATCH  /api/tasks/{id}             — update (incl. section move)
DELETE /api/tasks/{id}             — archive/delete
GET    /api/tasks/{id}/meta        — meta only
GET    /api/tasks/{id}/summary     — summary.md
PUT    /api/tasks/{id}/summary     — write summary.md
GET    /api/tasks/{id}/usage       — token usage
POST   /api/tasks/{id}/clear       — clear runs
POST   /api/tasks/{id}/link        — register session (used by self-register)
POST   /api/tasks/{id}/agents      — spawn child agent
POST   /api/tasks/{id}/continue    — continue last run
GET    /api/tasks/{id}/events      — SSE event stream
POST   /api/tasks/{id}/runs/{sid}/kill
POST   /api/tasks/{id}/runs/{sid}/prompt
GET    /api/tasks/{id}/runs/{sid}/diff
POST   /api/tasks/{id}/detect/refresh

DELIVERABLES
internal/api/tasks.go with one handler func per endpoint.
internal/meta/meta.go: atomic read/write of sessions/<id>/meta.json
  via tempfile + os.Rename, with file lock (single-writer).
Wire into server.go via OpenAPI-generated chi mount.

CONSTRAINTS — PARITY
- Compare each handler's response to actual Next response (use
  contract test framework from 0.6). Bytewise JSON match.
- Section transitions: only the 4 valid sections per CLAUDE.md.
  Coordinator never auto-promotes to "DONE — not yet archived".
- POST /agents must NOT shell out to `claude -p` in this handler;
  it enqueues via internal/spawn.Engine.
- Cookie auth middleware required on all routes except /link
  (which uses x-bridge-internal-token).

ACCEPTANCE
- Contract test framework: for each endpoint, capture Next response
  with seeded fixture, then call Go handler with same fixture, assert
  bytewise JSON equality + same Set-Cookie / Cache-Control / status.
- Manual smoke via UI Next (rewrites pointed at :8080):
  create task → spawn agent → live tail → kill → archive — all green.
```

### 6.5 — `backend-go-core`: auth & cookies

```
ROLE: backend-go-core
TASK ID: 1.4

CONTEXT
Port cookie-session auth. Source: libs/auth.ts, setupToken.ts,
loginApprovals.ts, permissionSettings.ts, rateLimit.ts,
errorResponse.ts; routes under app/api/auth/.

CRITICAL DECISION POINT
Inspect libs/auth.ts to determine cookie format (likely
iron-session or @oslojs). If format is iron-session AES-GCM:
  Option A: implement compatible decoder in Go (preferred — zero downtime).
  Option B: switch to JWT/Paseto, force re-login (require coordinator
  approval + RELEASE_NOTES entry).

Default: try Option A. If >1 day blocked, escalate.

DELIVERABLES
internal/auth/cookies.go — encode/decode session cookie matching
  Next implementation byte-for-byte (verify with round-trip test
  against a real cookie issued by current Next).
internal/auth/password.go — bcrypt with same cost factor.
internal/auth/setup_token.go — same TTL + format.
internal/auth/approvals.go — login approval flow.
internal/middleware/auth.go — chi middleware extracting session
  from cookie, attach user to ctx.
internal/middleware/ratelimit.go — token bucket per IP/user.
internal/api/auth.go — handlers for /api/auth/{login, logout, me,
  setup, devices, approvals, login/pending/{id}}.

ACCEPTANCE
- Round-trip test: cookie issued by current Next can be decoded by Go.
- Round-trip test: cookie issued by Go can be decoded by current Next
  (this verifies hot rolling upgrade).
- /me returns identical JSON shape, including user fields, approval flags.
- Rate limit returns 429 with same body shape as libs/errorResponse.ts.
```

### 6.6 — `backend-go-telegram`: PoC + port

```
ROLE: backend-go-telegram
TASK ID: 3.1 + 3.2

CONTEXT
Replace gramjs (Node) with gotd/td (Go) for Telegram MTProto.
Source TS: libs/telegramChatForwarder.ts, telegramIntent.ts,
scripts/telegram-login.ts, scripts/approve-login.ts; routes under
app/api/telegram/.

PHASE A — PoC (Day 1-3)
Build minimal Go program that:
1. Reads TELEGRAM_API_ID, TELEGRAM_API_HASH from env.
2. Performs interactive login (phone + code + 2FA) once, stores
   session to .bridge-state/telegram-go.session.
3. On second run, resumes session.
4. Sends one test message and reads incoming updates.

If after 3 days you can't get this working reliably:
  STOP. Open task 3.5-fallback: keep Node Telegram in a tiny
  sidecar process (telegram-bridge/), Go backend talks to it
  over localhost HTTP. Update plan and notify coordinator.

PHASE B — Port (after PoC succeeds)
1. internal/telegram/client.go — gotd/td wrapper with the same
   interface surface as libs/telegramChatForwarder.ts.
2. internal/telegram/intent.go — port command parser
   (see libs/__tests__/telegramCommands.test.ts for cases).
3. internal/telegram/important.go — port pattern matcher
   (see libs/__tests__/telegramImportantPatterns.test.ts).
4. internal/api/telegram.go — handlers for
   /api/telegram/{settings,test} and /api/telegram/user/{settings,test}.
5. cmd/bridge/telegram_login.go — `bridge telegram-login` cobra
   subcommand replacing scripts/telegram-login.ts.
6. cmd/bridge/approve_login.go — `bridge approve-login`.

CONSTRAINTS
- Session storage path MUST match what Node side wrote IF you can
  decode it (probably not — gramjs and gotd use different formats).
  Otherwise: store new format under .bridge-state/telegram-go.session
  and document re-login requirement.
- Command parser test cases from telegramCommands.test.ts — port
  every case to Go testify table test, must pass.

ACCEPTANCE
- PoC: send + receive 1 message round trip.
- Port: all telegram tests in Go pass (parity with vitest).
- Manual: /status command from real Telegram chat returns correct
  task list; forwarder posts session events to configured chat.
```

### 6.7 — `frontend-vite`: scaffold + first 3 pages

```
ROLE: frontend-vite
TASK ID: 5.1 + 5.2 + 5.3 (start of phase 5)

CONTEXT
Replace Next.js App Router with Vite SPA. Pages source:
app/page.tsx, app/tasks/page.tsx, app/tasks/[id]/page.tsx,
app/sessions/page.tsx, app/apps/page.tsx, app/usage/page.tsx,
app/tunnels/page.tsx, app/settings/page.tsx, app/login/page.tsx,
app/docs/page.tsx.

Components: app/_components/**.
Client utils: libs/client/**.

DELIVERABLES (this batch)
1. web/ scaffold: Vite 5, React 19, TS strict, Tailwind 4 + PostCSS.
   Reuse tailwind.config from current Next setup so design tokens
   match exactly.
2. web/vite.config.ts: dev proxy /api → http://localhost:8080,
   alias '@/' → 'web/src'.
3. TanStack Router file-based routes:
   /                 → web/src/pages/Home.tsx
   /tasks            → web/src/pages/TasksList.tsx
   /tasks/$id        → web/src/pages/TaskDetail.tsx
4. Port app/_components/Providers.tsx → web/src/providers.tsx
   (Theme, Confirm, Toasts — same children).
5. Port 3 pages above (Home, TasksList, TaskDetail). Replace:
   - next/link → @tanstack/react-router Link
   - next/navigation router/searchParams → useNavigate / useSearch
   - next/image → plain <img>
   - Server Component data fetching → @tanstack/react-query +
     fetch('/api/...') (use the existing fetch patterns in components)
6. Generate web/src/api/schema.ts from api/openapi.yaml.

CONSTRAINTS — UI/UX PARITY
- Pixel parity vs current Next render. Run `pnpm dev` on Next at
  :7777 and `vite dev` at :5173. Take Playwright screenshot of
  same page on both. Diff <2%.
- Keyboard shortcuts (cmd-k command palette, etc.) must still fire.
- Dark/light theme switch via existing ThemeProvider.
- All copy/text identical (translate not allowed — copy-paste).

ACCEPTANCE
- `pnpm --filter web dev` boots, http://localhost:5173 shows Home.
- Navigation between 3 routes works, no full page reload.
- Playwright screenshot diff <2% for the 3 pages, light + dark.
- TS strict + ESLint clean.
```

### 6.8 — `qa-parity`: contract test framework

```
ROLE: qa-parity / test-go
TASK ID: 0.6

CONTEXT
Build the parity test harness used by every backend port task.

DELIVERABLES
test/contract/ directory containing:
1. seed.go — programmatic fixture builder: writes bridge.json,
   sessions/<id>/meta.json, fake ~/.claude/projects/<slug>/<sid>.jsonl.
2. record.go — runs against Next at :7777, records full
   HTTP response (status, headers, body) into testdata/<endpoint>/golden.json.
3. replay.go — runs against Go at :8080, asserts bytewise equality
   with golden, emits structured diff on failure.
4. cmd/contract/main.go — CLI: `contract record <endpoint>` and
   `contract verify <endpoint>` and `contract verify-all`.
5. Integration with `make test`: `make contract` runs verify-all.

CONSTRAINTS
- Header normalization: ignore Date, set-cookie expiry epoch (use
  fixed clock), request-id headers. Document the ignore list.
- Body normalization: NONE. Bytewise equal or fail.
- Streaming responses (SSE): record first 5 events then stop.
- Multipart upload: include hash of file payload, not raw bytes.

ACCEPTANCE
- `contract record GET /api/tasks/meta` produces golden.
- `contract verify GET /api/tasks/meta` against Go stub fails
  (because Go returns 501). Make Go return same shape; verify passes.
- Document workflow in test/contract/README.md (used by all sub-agents).
```

### 6.9 — Reviewer prompt (per PR)

```
ROLE: reviewer
TASK ID: PR-<number>

You are reviewing a migration PR for claude-bridge Next→Go.

MUST CHECK
1. Parity Rules in MIGRATION_GO.md §3 — every applicable rule.
2. Contract test exists for every new/changed endpoint, currently
   passing (see CI run).
3. Go test coverage matches the equivalent Vitest file (count
   parity, not %): if libs/__tests__/sessions.test.ts has 12 cases,
   internal/sessions/sessions_test.go must have 12 equivalent cases.
4. No commits modifying schemas (bridge.json, meta.json) without
   explicit migration note in PR description.
5. No git commit/checkout/push from spawned children.
6. Cross-platform: Windows + Linux process kill paths both implemented.
7. Cookie / SSE / file format unchanged.

OUTPUT
Comment with sections:
- Parity violations (block)
- Test gaps (block)
- Code quality nits (non-blocking)
- Approval / Request changes
```

---

## 7. Test & Verification

### 7.1 Test pyramid

| Tầng | Hiện tại (TS) | Sau migrate (Go) |
|---|---|---|
| Unit | Vitest 50 file | Go `testing` + `testify`, 1:1 case parity |
| Contract | (chưa có) | golden file framework §6.8 — bytewise diff Next vs Go |
| Integration | một phần Vitest | Go integration tests (real FS, fake `claude` binary) |
| E2E | Playwright (rải rác) | Playwright suite mở rộng, chạy trên cả Next và Go server |
| Visual | (chưa có) | Playwright screenshot diff <2% cho 10 page × 2 theme |
| Load | (chưa có) | k6: 100 RPS lên `/api/tasks/meta`, p99 < baseline Next |

### 7.2 Parity workflow per endpoint

```
1. backend-go ports endpoint → branch
2. test-go writes contract record (against Next baseline)
3. backend-go iterates Go implementation until contract verify passes
4. reviewer audits per §6.9
5. coordinator merges, flips next.config.js rewrite to :8080
6. qa-parity runs Playwright smoke; if green, close task
```

### 7.3 Rollback

- **Per-route**: revert rewrite in `next.config.js`, traffic về Next ngay lập tức.
- **Per-domain**: feature flag `BRIDGE_GO_BACKENDS=tasks,sessions` chỉ định domain nào đi Go. Tắt flag = về Next.
- **Toàn bộ**: revert PR cutover (Phase 6.4-6.5), Next + node_modules vẫn còn cho đến khi Phase 7 done.

---

## 8. Rủi ro & Mitigation

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Telegram MTProto port không khả thi | Trung bình | Cao — block toàn dự án | PoC ngày 1; fallback Node sidecar nếu PoC fail sau 3 ngày |
| Cookie format không round-trip được | Thấp | Trung bình — buộc re-login toàn bộ user | Inspect `libs/auth.ts` ở Phase 0; nếu phải đổi, đưa vào RELEASE_NOTES |
| Spawn process trên Windows kill không sạch | Trung bình | Cao — orphan process | Test sớm với job objects ở Phase 1.2; CI Windows runner |
| SSE behavior khác nhau (Next streaming quirks) | Trung bình | Trung bình — UI mất live update | Contract test ghi lại 5 event đầu, so sánh framing |
| UI pixel diff vượt ngưỡng do font/Tailwind v4 quirk | Thấp | Thấp | Lock font version, chạy diff trên Linux runner cho ổn định |
| Tree-sitter Go bindings cồng kềnh | Thấp | Thấp | Fallback: shell-out `tree-sitter` CLI |
| Migration kéo dài quá tuần 7 | Trung bình | Trung bình | Strangler-fig giữ Next chạy được suốt → không deadline cứng để cutover |

---

## 9. Definition of Done

- [ ] Tất cả 65 endpoint đã port, contract test pass.
- [ ] Tất cả 50 test Vitest có equivalent Go test, pass.
- [ ] Playwright E2E + visual diff pass cho 10 page.
- [ ] Single binary `bridge` <50MB, RAM idle <50MB, p99 latency <50ms cho route đọc thuần.
- [ ] `node_modules` ở root xóa, `package.json` chỉ còn ở `web/` cho dev tooling.
- [ ] `CLAUDE.md`, `BRIDGE.md`, `prompts/coordinator.md` cập nhật.
- [ ] `make build` + cross-compile 6 platform CI xanh.
- [ ] Smoke test thủ công: tạo task, spawn 2 agent song song, kill 1, archive — không có regression so với Next baseline.
- [ ] Telegram bridge gửi/nhận và lệnh `/status` hoạt động (hoặc fallback sidecar được document).
- [ ] RELEASE_NOTES có entry đầy đủ về cookie/format change (nếu có).

---

## 10. Phụ lục — Mapping nhanh

### 10.1 TS lib → Go package

| TS | Go |
|---|---|
| `libs/sessions.ts` | `internal/sessions/sessions.go` |
| `libs/sessionUsage.ts`, `usageStats.ts` | `internal/usage/` |
| `libs/spawn.ts` + co. | `internal/spawn/` |
| `libs/auth.ts`, `setupToken.ts`, `loginApprovals.ts` | `internal/auth/` |
| `libs/git.ts`, `worktrees.ts` | `internal/git/` |
| `libs/detect/*`, `scanApp.ts` | `internal/detect/` |
| `libs/repos.ts`, `repoProfile.ts`, `repoHeuristic.ts` | `internal/repos/` |
| `libs/memory.ts`, `memoryDistill.ts`, `pinnedFiles.ts`, `contextAttach.ts` | `internal/memory/` |
| `libs/qualityGate.ts`, `validate.ts`, `styleFingerprint.ts`, `houseRules.ts`, `playbooks.ts`, `promptStore.ts` | `internal/quality/` |
| `libs/symbolIndex.ts` | `internal/symbol/` |
| `libs/telegramChatForwarder.ts`, `telegramIntent.ts` | `internal/telegram/` |
| `libs/uploadGuards.ts` | `internal/upload/` |
| `libs/rateLimit.ts`, `errorResponse.ts` | `internal/middleware/` |
| `libs/inFlight.ts` | `internal/spawn/registry.go` (`sync.Map`) |

### 10.2 Next page → Vite route

| Next | Vite (TanStack Router) |
|---|---|
| `app/page.tsx` | `web/src/pages/Home.tsx`, route `/` |
| `app/tasks/page.tsx` | `web/src/pages/TasksList.tsx`, route `/tasks` |
| `app/tasks/[id]/page.tsx` | `web/src/pages/TaskDetail.tsx`, route `/tasks/$id` |
| `app/sessions/page.tsx` | `web/src/pages/SessionsBrowser.tsx`, route `/sessions` |
| `app/apps/page.tsx` | `web/src/pages/Apps.tsx`, route `/apps` |
| `app/usage/page.tsx` | `web/src/pages/Usage.tsx`, route `/usage` |
| `app/tunnels/page.tsx` | `web/src/pages/Tunnels.tsx`, route `/tunnels` |
| `app/settings/page.tsx` | `web/src/pages/Settings.tsx`, route `/settings` |
| `app/login/page.tsx` | `web/src/pages/Login.tsx`, route `/login` |
| `app/docs/page.tsx` | `web/src/pages/Docs.tsx`, route `/docs` |

### 10.3 Go libs cố định

```
github.com/go-chi/chi/v5            # router
github.com/spf13/cobra              # CLI
github.com/rs/zerolog               # logging
github.com/fsnotify/fsnotify        # file watcher
github.com/gotd/td                  # MTProto (PoC trước)
github.com/go-git/go-git/v5         # git ops (or shell-out)
golang.org/x/crypto/bcrypt          # password
github.com/getkin/kin-openapi       # openapi runtime validation
github.com/oapi-codegen/oapi-codegen/v2  # codegen
github.com/stretchr/testify         # test
github.com/smacker/go-tree-sitter   # symbol index (or CLI fallback)
```

### 10.4 Vite/FE deps

```
vite ^5
react ^19, react-dom ^19
@tanstack/react-router ^1
@tanstack/react-query ^5
tailwindcss ^4
@radix-ui/* (giữ y nguyên list từ package.json hiện tại)
class-variance-authority, clsx, tailwind-merge
react-markdown, remark-gfm
lucide-react
openapi-fetch, openapi-typescript (devDep)
@fontsource/<font hiện tại>
playwright (devDep, e2e)
```

---

> **Sửa đổi tài liệu này**: chỉ coordinator được phép edit. Sub-agent phát hiện sai sót → ghi vào `summary.md` với prefix `PLAN-FIXUP:` để coordinator gom lại thành 1 PR cập nhật `MIGRATION_GO.md`.
