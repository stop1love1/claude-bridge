<p align="center">
  <img src="public/logo.svg" alt="Claude Bridge" width="120" />
</p>

<h1 align="center">Claude Bridge</h1>

<p align="center">
  <strong>One dashboard to dispatch Claude across every repo.</strong><br />
  Hand off the task → coffee ☕ · beer 🍺 · walk the dog 🐕 · nap 😴 → the bridge pings you when it ships 📨
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
- 🛡️ **Gates risky tools** behind an Allow / Deny popup in any session you drive yourself.
  Dispatched children run headless, held at the ship gate by the verify chain below.
- ✅ **Runs the verify chain** (your `test` / `lint` / `build` → preflight → claim-vs-diff → style critic → semantic)
  before declaring anything *done*, with a configurable 6-gate retry ladder feeding the failure transcript
  back to a fix agent.
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
| 🛡️ **Per-tool permission gates** | In a session you drive from the chat UI, risky calls (`Bash`, `Edit`, `Write`, `Delete`, …) pause behind an Allow / Deny popup, and your answers build a reusable per-session allowlist. Agents the coordinator dispatches run in bypass mode — they have no TTY to prompt against and would hang on their first tool call — so they're held at the ship gate instead: nothing is committed, merged, or pushed until the verify chain passes. Fence them off from your working tree too by setting that app's branch policy to a per-task branch or a fresh worktree. |
| ✅ **Verify-then-ship chain** | Every successful child run is gated by five checks, in this order: your app's `test` / `lint` / `build` → **preflight** (did the agent read enough before it started editing?) → **claim-vs-diff** (does what it says it changed match what git says?) → **style critic** (does the diff look like this codebase?) → **semantic** (does the diff actually do what the task asked?). The first one to block stops the run short of any commit, merge, or push. Failures fan out into a 6-gate retry ladder (crash / verify / claim / preflight / style / semantic), each with its own configurable budget — the failure transcript is fed back to a fix agent on every retry. |
| 📨 **Telegram bridge** | Spawn tasks, watch transitions, kill runs, or read a report from your phone. Bot + user-client channels with chat-id allowlist and natural-language command routing — the reason you can actually leave the desk. |

### 🎁 What else is in the box

The smaller stuff that makes the five pillars pleasant to live with:

- 🔍 **Auto-detect any stack** — Next.js, NestJS, Prisma, Express, Vue, Svelte, Tailwind, Python, Go, Rust, Java, and more.
- 🗂️ **Task lifecycle in the UI** — `TODO → DOING → DONE / BLOCKED` in one click; stable ids, bodies, run trees.
- 📋 **Plan gate** — before anything is dispatched, a planner drafts the approach and asks its clarifying questions (bounded rounds, on by default); nothing spawns until you approve.
- 🔁 **Scheduled workflows** — name an ordered set of stages (role + prompt + verify on/off), pin them to an app, and run them on demand or on a cron.
- 🤖 **Auto-queue** — let the bridge drain `TODO` unattended with a concurrency cap, instead of dispatching each task by hand.
- 🔗 **Task share links** — hand a stakeholder a token link scoped to one task, with seven grants to pick from (send a message, spawn an agent, answer a permission prompt, commit, push, approve a plan, view the preview), its own branch policy, an expiry, and per-device approval you can revoke. The share dialog opens with messaging and permission answers already ticked — untick them for a read-only link.
- 🏁 **Speculative runs + judge panel** — race sibling attempts in isolated worktrees and keep the first to claim; multi-lens voting backs both the style and semantic gates.
- 🚢 **Integration modes** — per app, a run that ships can stop at the commit, auto-merge into your target branch, or hand off to a `devops` role that opens the PR/MR through `gh` / `glab` (GitHub + GitLab).
- 🌿 **Branch-aware dispatch** — per-app git policy (current / fixed / `claude/<task-id>` / fresh worktree) + optional auto-commit & push.
- 📝 **Cross-repo registers** — `decisions.md`, `bugs.md`, `questions.md` so cross-repo agreements outlive the AI session.
- 💬 **Session continuation + rewind** — resume past sessions with full transcript replay or rewind to any message.
- 💰 **Token usage analytics** — per-task input / output / cache totals with per-run drill-down.
- 🔔 **Web push** — browser notifications (VAPID) as an alternative to Telegram when you'd rather not wire up a bot.
- 🔐 **Single-operator auth** — scrypt password + signed cookie + trusted devices + CSRF + rate-limited login + optional Telegram login approvals.
- 📊 **Repo profiles** — heuristic per-repo summaries injected into every child prompt.
- 🧩 **Pre-warmed child context** — every spawn ships with house rules, pinned files, a symbol index, the repo's style fingerprint, and the most recent coordinator direction so children don't start cold.
- 🧠 **Task memory** — top extracted notes from prior runs on the same task get folded into the next coordinator prompt, so re-dispatches don't re-litigate decisions the team already made.
- ⚙️ **Package-manager-agnostic** — install and run with Bun, npm, or pnpm; the scripts themselves shell out to Node, never to one specific manager.
- 🌐 **Demo-mode deployable** — flip a single env var to host the landing page on Vercel/Netlify without exposing the dashboard.
- 🛰️ **One-click public tunnels** — pick a local port, choose `cloudflare` (free, no signup, no interstitial), `localtunnel` (free, no signup), or `ngrok` (one-time authtoken), and share the public URL. The bridge installs cloudflared or ngrok via winget/brew/binary if they aren't on PATH.

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
                  │  no tool prompts │  │  no tool prompts │
                  └────────┬─────────┘  └────────┬─────────┘
                           │                     │
                           ▼                     ▼
                ┌─────────────────────────────────────────┐
                │  Verify-then-ship chain                 │
                │  test/lint/build → preflight →          │
                │  claim-vs-diff → style critic →         │
                │  semantic — first block stops the run   │
                │  fail → retry ladder w/ failure context │
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

**Requirements:** Node 20+ (the server runs on it), plus the `claude` CLI authenticated however you'd
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
> headless deploys), `npm run set:password` does the same thing as the in-UI form.

### Production env vars

Set these before `bun run start` to point the bridge at a non-default host or port:

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_PORT` | `7777` | Listening port. `PORT` is also honored. |
| `BRIDGE_HOST` | `127.0.0.1` | Interface to bind. Loopback-only by default — the bridge serves a shell-spawning PTY endpoint, so reaching the LAN is opt-in. Set `0.0.0.0` to accept clients on your network. Tunnels work either way (providers dial `localhost` from this machine). |
| `BRIDGE_URL` | `http://localhost:$BRIDGE_PORT` | Public origin spawned children & webhooks call back to. Set this when reverse-proxying or running behind a hostname. |
| `NODE_ENV` | `production` (set by `bun run start`) | Enables secure cookies. |
| `BRIDGE_DEMO_MODE` | unset | When `1`, runs in landing-page-only mode (see [Deployment](#-deployment)). |

For a long-running deploy, run `bun run start` under a process supervisor
(`systemd`, `pm2`, Docker, …) so it restarts cleanly on reboot. On Windows,
[`scripts/install-service.ps1`](scripts/install-service.ps1) does the same job
through Task Scheduler with no extra dependencies — see
[`docs/24-7-setup.md`](docs/24-7-setup.md) for the full 24/7 setup. For local
hacking on the bridge itself, use `bun run dev` instead — Turbopack hot-reload,
no auth-cookie hardening.

---

## 🌐 Deployment

The bridge needs **Claude, git, and persistent disk** to do real work, so its primary deployment
target is your laptop or a long-running VM (a `bun run start` behind your VPN is a perfectly fine
home-lab setup).

For a public showcase you can host the landing page only — set `BRIDGE_DEMO_MODE=1` and:

- Dashboard CTAs (`Open dashboard`, `Get started`, `Jump in`) are hidden on the landing page.
- Every dashboard route (`/apps`, `/tasks`, `/sessions`, `/settings`, `/tunnels`, `/login`) redirects to `/`.
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

The aim is to be the most capable **agentic coding control plane** on your machine —
model-agnostic, repo-agnostic, tracker-agnostic.

### Shipped

- [x] Verify-then-ship chain + 6-gate retry ladder (crash / verify / claim / preflight / style / semantic)
- [x] Speculative sibling runs — race attempts in isolated worktrees, keep the first to claim
- [x] Multi-lens judge panel behind the semantic gate
- [x] Plan gate — clarifying questions + operator approval before anything is dispatched
- [x] Scheduled workflows — multi-stage role pipelines, on demand or on a cron
- [x] Auto-queue — drain `TODO` unattended with a concurrency cap
- [x] Branch-aware dispatch with per-spawn `git worktree` isolation
- [x] Task share links — token + device-approved guest access with per-grant capabilities
- [x] Telegram bridge for remote control + notifications, plus web push
- [x] Integration modes per app — commit only, auto-merge, or a `devops` role that opens the PR/MR (`gh` / `glab`, GitHub + GitLab)
- [x] Built-in token usage analytics per task
- [x] Single-operator auth with trusted devices + login approvals
- [x] One-click public tunnels (cloudflare + localtunnel + ngrok auto-install)

### Next

- [ ] Per-role / per-task model pinning — model discovery and the `--model` plumbing are in; dispatched children still inherit the CLI default
- [ ] Whole-dashboard read-only mode for stakeholders — share links cover one task at a time today
- [ ] UI-managed role playbooks + packaging, so adding a custom role (security-auditor, perf-tuner, …) isn't a file edit
- [ ] LLM-assisted repo profiles — profiles are heuristic-only; `summarizeWithLLM` is still a stub
- [ ] Codebase knowledge graph — the symbol index and per-task memory exist; the cross-repo graph on top of them doesn't
- [ ] GitHub bridge beyond PR creation — issue → task, PR-review bot, CI-failure → fix
- [ ] First-class monorepo support (Nx, Turbo, pnpm / Bun workspaces)

### Later

- [ ] Multi-LLM support — Claude + GPT, Gemini, Grok, DeepSeek, OpenRouter, and local models (Ollama / vLLM) behind one loop
- [ ] Sandboxed execution — each child in an ephemeral Docker/VM with declared scope
- [ ] Policy engine — declarative invariants enforced by the verify chain
- [ ] Long-horizon autonomous mode — hand over a goal, the bridge backplans and ships PRs on top of the auto-queue
- [ ] Editor companions (VS Code, JetBrains) + CLI client
- [ ] Linear / Jira bridges
- [ ] A permissive license (MIT or Apache-2.0) — see [License](#-license)

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

Please keep changes package-manager-agnostic — a `package.json` script must not invoke `bun`,
`npm`, or `pnpm` by name, so it behaves the same whichever one the user reaches for. Tests use
Vitest; the test runner is the same regardless of your local setup.

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
