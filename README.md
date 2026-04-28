<p align="center">
  <img src="public/logo.svg" alt="Claude Bridge" width="120" />
</p>

<h1 align="center">Claude Bridge</h1>

<p align="center">
  <strong>One dashboard to dispatch Claude across every repo.</strong><br />
  Hand off the task. Go grab a coffee. ☕ The bridge dispatches, verifies, and pings you when it ships.
</p>

<p align="center">
  <a href="#-why-claude-bridge"><strong>Why</strong></a> ·
  <a href="#-the-five-pillars"><strong>Pillars</strong></a> ·
  <a href="#-how-it-works"><strong>How it works</strong></a> ·
  <a href="#-quick-start"><strong>Quick start</strong></a> ·
  <a href="#-deployment"><strong>Deploy</strong></a> ·
  <a href="#-full-reference"><strong>Docs</strong></a> ·
  <a href="#-roadmap"><strong>Roadmap</strong></a>
</p>

<p align="center">
  <a href="https://github.com/stop1love1/claude-bridge/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/stop1love1/claude-bridge?style=for-the-badge&color=e3b95a&logo=github&logoColor=white&labelColor=12151c"></a>
  <a href="https://github.com/stop1love1/claude-bridge/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/stop1love1/claude-bridge?style=for-the-badge&color=6aa8ff&labelColor=12151c"></a>
  <a href="https://github.com/stop1love1/claude-bridge/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-65c58c?style=for-the-badge&labelColor=12151c"></a>
  <a href="#-license"><img alt="License" src="https://img.shields.io/badge/license-pending-b17ad8?style=for-the-badge&labelColor=12151c"></a>
</p>

<p align="center">
  <a href="https://nextjs.org/"><img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white"></a>
  <a href="https://tailwindcss.com/"><img alt="Tailwind v4" src="https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white"></a>
  <a href="https://bun.sh/"><img alt="Bun" src="https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node 20+" src="https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-Coordinator-d97757"></a>
</p>

---

## ✨ Why Claude Bridge

You finally got Claude Code working great in *one* repo. Then a feature lands that touches three:
the API, the web client, and a shared schema. Suddenly you're juggling terminal tabs, copy-pasting
context between sessions, and *babysitting* AI work that was supposed to save you time.

**Claude Bridge is the off-ramp.** Describe the task in plain prose; the bridge does the rest:

- 🧭 **Picks the right repos** and spawns a coder agent in each.
- 📺 **Streams every agent live** to one dashboard you don't have to stare at.
- 🛡️ **Gates risky tools** behind a popup so nothing scary happens unsupervised.
- ✅ **Runs the verify chain** (preflight + semantic + style + your `test` / `lint` / `build`)
  before declaring anything *done*, and auto-retries once on failure.
- 📨 **Pings your phone** over Telegram when it ships — or when it needs a human call.

So the loop becomes: *type the task → close the laptop → go pour a coffee, walk the dog, or
crack open a beer.* When your phone buzzes, the work is already verified.

> **Who is this for?** Solo devs juggling a frontend + backend repo. Small teams with a service +
> client + shared package. Anyone whose AI workflow currently involves five terminal tabs and a
> sticky note tracking which prompt went where.

### Status

The bridge is **active development** and used daily in production by the author. The core
loop — multi-repo dispatch, live monitoring, permission gates, verify-then-ship, Telegram
control — is stable. Expect rapid iteration on the periphery. Breaking changes are called
out in releases; runtime data lives in `sessions/` and `bridge.json` and is migration-aware.

---

## 🚀 The five pillars

These are the load-bearing pieces — everything else exists to make them work better.

| | |
|---|---|
| 🧭 **Multi-repo coordinator** | One agent reads the task, picks which sibling repos it touches, and spawns coder / reviewer / fixer children in the right working directory. No naming convention, no hardcoded paths. |
| 📺 **Live dashboard** | Token-level streaming of every agent's output, SSE status updates, and a per-task tree of parent / child runs — so when you *do* peek, you see everything at once. |
| 🛡️ **Per-tool permission gates** | Risky calls (`Bash`, `Edit`, `Write`, `Delete`, …) pause behind an Allow / Deny popup. Build up reusable allowlists per session; bypass mode for trusted children only. |
| ✅ **Verify-then-ship chain** | Every successful child run is gated by preflight → semantic → style critic → your app's `test` / `lint` / `build`. If anything fails, the bridge auto-retries once with the failure transcript fed back to a fix agent. |
| 📨 **Telegram bridge** | Spawn tasks, watch transitions, kill runs, or read a report from your phone. Bot + user-client channels with chat-id allowlist and natural-language command routing — the reason you can actually leave the desk. |

### 🎁 What else is in the box

The smaller stuff that makes the five pillars pleasant to live with:

- 🔍 **Auto-detect any stack** — Next.js, NestJS, Prisma, Express, Vue, Svelte, Tailwind, Python, Go, Rust, Java, and more.
- 🗂️ **Task lifecycle in the UI** — `TODO → DOING → DONE / BLOCKED` in one click; stable ids, bodies, run trees.
- 🌿 **Branch-aware dispatch** — per-app git policy (current / fixed / `claude/<task-id>` / fresh worktree) + optional auto-commit & push.
- 📝 **Cross-repo registers** — `decisions.md`, `bugs.md`, `questions.md` so cross-repo agreements outlive the AI session.
- 💬 **Session continuation + rewind** — resume past sessions with full transcript replay or rewind to any message.
- 💰 **Token usage analytics** — per-task input / output / cache totals with per-run drill-down.
- 🔐 **Single-operator auth** — scrypt password + signed cookie + trusted devices + CSRF + rate-limited login + optional Telegram login approvals.
- 📊 **Repo profiles** — heuristic per-repo summaries injected into every child prompt.
- ⚙️ **Runtime-agnostic** — runs identically under Bun, npm, or pnpm.
- 🌐 **Demo-mode deployable** — flip a single env var to host the landing page on Vercel/Netlify without exposing the dashboard.

---

## 🧠 How it works

```
                       ┌──────────────────────────┐
                       │   Claude Bridge UI       │
                       │   localhost:7777         │
                       └────────────┬─────────────┘
                                    │  task: "Bump auth lib + update callers"
                                    ▼
                       ┌──────────────────────────┐
                       │    Coordinator agent     │
                       │  (reads BRIDGE.md +      │
                       │   markdown registers +   │
                       │   per-repo profiles)     │
                       └─────┬──────────────┬─────┘
                             │              │
                  spawns ◄───┘              └───► spawns
                             │              │
                             ▼              ▼
                  ┌──────────────────┐  ┌──────────────────┐
                  │ coder · app-api  │  │ coder · app-web  │
                  │  streams tokens  │  │  streams tokens  │
                  │  ↑ tool gates    │  │  ↑ tool gates    │
                  └────────┬─────────┘  └────────┬─────────┘
                           │                     │
                           ▼                     ▼
                ┌─────────────────────────────────────────┐
                │  Verify-then-ship chain                 │
                │  preflight → semantic → style critic →  │
                │  your app's test/lint/build commands    │
                │  fail → auto-retry once with context    │
                └────────────────────┬────────────────────┘
                                     ▼
                          ┌──────────────────┐
                          │  reviewer agent  │  ◄─ optional
                          └──────────────────┘
```

Sibling paths resolve as `../<folder-name>`. There are no hardcoded absolute paths — rename or
move freely, just keep the bridge as a sibling of your app folders.

---

## ⚡ Quick start

**Requirements:** Node 20+ *or* Bun 1.x, plus the `claude` CLI authenticated however you'd
normally use it (Anthropic API key, Pro, or workspace).

```bash
# 1. Clone the bridge as a sibling of your app repos
cd <parent-folder-that-holds-your-app-repos>
git clone https://github.com/stop1love1/claude-bridge.git && cd claude-bridge

# 2. Install dependencies — pick a runtime (all three are first-class)
bun install                      # Bun
npm install                      # npm
pnpm install                     # pnpm

# 3. Build + start the production server (http://localhost:7777)
bun run serve                    # Bun
npm run serve                    # npm
pnpm run serve                   # pnpm
```

That's it. On first visit the login page shows an in-browser **Setup** form (email +
password) so you don't need a separate CLI step. After that:

1. **Apps tab** → **Auto-detect** to scan siblings, or **Add app** by hand.
2. **+ New task** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>N</kbd>) → describe the work in prose.
3. *(Optional)* **Settings → Telegram** so your phone gets pinged when tasks ship.
4. ☕ / 🛏️ / 🍻.

> **Tip:** The first run creates `bridge.json` (apps registry) and `sessions/` (task history).
> Both are git-ignored by default — your project state stays separate from the bridge code.

> **CLI password setter:** If you'd rather seed the password from the terminal (e.g. for
> headless deploys), `bun run set:password` does the same thing as the in-UI form.

### Production env vars

Set these before `bun run start` to point the bridge at a non-default host or port:

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_PORT` | `7777` | Listening port. `PORT` is also honored. |
| `BRIDGE_URL` | `http://localhost:$BRIDGE_PORT` | Public origin spawned children & webhooks call back to. Set this when reverse-proxying or running behind a hostname. |
| `NODE_ENV` | `production` (set by `bun run start`) | Enables secure cookies. |
| `BRIDGE_DEMO_MODE` | unset | When `1`, runs in landing-page-only mode (see [Deployment](#-deployment)). |

For a long-running deploy, run `bun run start` under a process supervisor
(`systemd`, `pm2`, Docker, …) so it restarts cleanly on reboot. For local
hacking on the bridge itself, use `bun run dev` instead — Turbopack hot-reload,
no auth-cookie hardening.

---

## 🌐 Deployment

The bridge needs **Claude, git, and persistent disk** to do real work, so its primary deployment
target is your laptop or a long-running VM (a `bun run start` behind your VPN is a perfectly fine
home-lab setup).

For a public showcase you can host the landing page only — set `BRIDGE_DEMO_MODE=1` and:

- Dashboard CTAs (`Open dashboard`, `Get started`, `Jump in`) are hidden on the landing page.
- Every dashboard route (`/apps`, `/tasks`, `/sessions`, `/settings`, `/login`) redirects to `/`.
- Every non-public `/api/*` call returns `503 { error: "demo mode" }`.

`/` and `/docs` stay public so visitors can read the pitch and docs. Anyone wanting the real
dashboard clones the repo and runs `bun run start` locally.

---

## 📚 Full reference

The bridge ships its own docs page — once it's running (`bun run start` or
`bun run dev`), visit **[localhost:7777/docs](http://localhost:7777/docs)** for:

- Environment variables (`BRIDGE_PORT`, `BRIDGE_URL`, `CLAUDE_BIN`, `BRIDGE_DEMO_MODE`, …)
- Apps registry schema (`git`, `verify`, `pinnedFiles`, `quality`, …)
- Authentication, permission modes, and Telegram setup
- Full scripts table (`set:password`, `telegram:login`, `approve:login`, …)
- FAQ

Or browse the source: [`app/docs/page.tsx`](app/docs/page.tsx).

---

## 🗺️ Roadmap

- [ ] LLM-assisted repo profile summaries (currently heuristic-only)
- [ ] More retry strategies than single-shot auto-retry
- [ ] Read-only public dashboard mode for stakeholders
- [ ] First-class support for monorepo workspaces (Nx, Turbo, pnpm workspaces)
- [ ] Plugin system for custom agent roles
- [x] Built-in token usage analytics per task
- [x] Telegram bridge for remote control + notifications
- [x] Verify-then-ship chain (preflight + semantic + style + per-app commands)
- [x] Branch-aware dispatch with per-spawn `git worktree` isolation
- [x] Single-operator auth with trusted devices + login approvals

Have an idea? [Open an issue](https://github.com/stop1love1/claude-bridge/issues) — feedback
shapes the roadmap.

---

## 🤝 Contributing

Issues and pull requests are welcome.

```bash
# Fork, clone, branch
git checkout -b feature/<short-name>

# Run tests + lint before pushing
bun run test
bun run lint

# Open a PR against `main`
```

Please keep changes runtime-agnostic — anything you add should run identically under Bun, npm,
and pnpm. Tests use Vitest; the test runner is the same regardless of your local runtime.

---

## 🔒 Privacy & data

- The dashboard, registry, transcripts, and session data **stay on your disk**. Nothing is
  uploaded by the bridge itself.
- The only network traffic is whatever the `claude` CLI would already do — prompts and tool
  calls to Anthropic — plus optional Telegram if you opt in.
- No telemetry. No analytics. No "anonymized" usage pings.

---

## 👤 Author

Built with care by **[@stop1love1](https://github.com/stop1love1)**.

If Claude Bridge saves you time, [a star on GitHub](https://github.com/stop1love1/claude-bridge) is
the easiest way to say thanks — it helps other teams discover the project.

<p>
  <a href="https://github.com/stop1love1/claude-bridge">
    <img alt="Star on GitHub" src="https://img.shields.io/github/stars/stop1love1/claude-bridge?style=social">
  </a>
</p>

---

## 📄 License

The project is currently published **without a license**. That means default copyright applies —
please open an issue if you want to discuss usage, redistribution, or relicensing. A permissive
license (MIT or Apache-2.0) is on the roadmap.
