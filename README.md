<p align="center">
  <img src="public/logo.svg" alt="Claude Bridge" width="128" />
</p>

<h1 align="center">Claude Bridge</h1>

<p align="center">
  <strong>One dashboard to dispatch Claude Code agents across every repo.</strong>
</p>

<p align="center">
  Multi-repo task management, live agent monitoring, and per-tool permission control —
  runtime-agnostic, stack-agnostic, no lock-in.
</p>

<p align="center">
  <a href="https://nextjs.org/"><img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white"></a>
  <a href="https://tailwindcss.com/"><img alt="Tailwind v4" src="https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white"></a>
  <a href="https://bun.sh/"><img alt="Bun" src="https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node 20+" src="https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-Coordinator-d97757"></a>
  <a href="https://github.com/stop1love1/claude-bridge/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-65c58c"></a>
  <a href="https://github.com/stop1love1/claude-bridge/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/stop1love1/claude-bridge?style=flat&color=e3b95a&logo=github"></a>
</p>

<p align="center">
  <a href="#-why-claude-bridge">Why</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-installation">Install</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-how-it-works">How It Works</a> ·
  <a href="#-configuration">Config</a> ·
  <a href="#-faq">FAQ</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

---

## ✨ Why Claude Bridge

You finally got Claude Code working great in *one* repo. Then a feature lands that touches three:
the API, the web client, and a shared schema. Suddenly you're juggling terminal tabs, copy-pasting
context between sessions, and praying nothing drifts.

**Claude Bridge fixes that.** Drop it next to your repos and you get:

- 🎯 **One coordinator** that reads the task, picks the right repos, and spawns child agents in each.
- 📺 **One dashboard** showing every agent's live output, status, and tool calls.
- 🛡️ **One permission gate** in front of risky operations — review before Claude writes.

No project naming convention. No vendor lock-in. Works on whatever stack you already have.

> **Who is this for?** Solo devs juggling a frontend + backend repo, small teams with a service +
> client + shared package, anyone tired of switching terminals every two minutes when AI work
> spans more than one codebase.

---

## 🚀 Features

| | |
|---|---|
| 🧭 **Multi-repo orchestration** | A coordinator agent decides which sibling repos a task touches and spawns coder, reviewer, and fixer agents in the right working directory. |
| 🔍 **Auto-detect any stack** | Scans sibling folders for Next.js, NestJS, Prisma, Express, Vue, Svelte, Tailwind, Python, Go, Rust, Java, and more — no hardcoded project names. |
| 🗂️ **Task lifecycle in the UI** | Tasks flow through `TODO → DOING → DONE / BLOCKED` with one click. Each task has a stable id, body, and an agent run tree. |
| 📡 **Live monitoring** | Token-level streaming of every agent's output, instant SSE status updates, and a per-task tree showing parent / child relationships. |
| 🛂 **Per-tool permission gates** | Risky tool calls (`Bash`, `Edit`, `Write`, `Delete`, …) pause behind a popup until you allow or deny — with reusable allowlists per session. |
| ♻️ **Resilient by default** | Auto-retry once on failure with the failure context injected into the fix agent. Stale-run reaper keeps the dashboard honest. |
| 💬 **Session continuation** | Open any past session and pick up the conversation with full transcript replay. |
| 📝 **Markdown registers** | `decisions.md`, `bugs.md`, `questions.md`, `contracts/` capture cross-repo agreements the coordinator reads before planning. |
| 🌿 **Branch-aware dispatch** | Per-app git policy: stay on current branch, fix to one branch, or auto-create `claude/<task-id>` per task. Optional auto-commit + push. |
| ⚙️ **Runtime-agnostic** | Runs identically under Bun, npm, or pnpm — no lockfile religion. |

---

## 🧠 How It Works

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
                       │   markdown registers)    │
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
                           └──────────┬──────────┘
                                      ▼
                            ┌─────────────────┐
                            │  reviewer agent │  ◄─ optional
                            └─────────────────┘
```

Sibling paths are resolved as `../<folder-name>`. There are no hardcoded absolute paths
anywhere — rename or move freely, just keep the bridge as a sibling of your app folders.

---

## 📋 Requirements

- **Node.js 20+** (for npm / pnpm) or **Bun 1.x**
- **Claude Code CLI** installed and authenticated. See [docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code) for setup.
- A workspace with at least one sibling app repo (any stack).

---

## 📦 Installation

Clone the bridge as a **sibling** of your app repos:

```bash
cd <parent-folder-that-holds-your-app-repos>
git clone https://github.com/stop1love1/claude-bridge.git
cd claude-bridge
```

Install dependencies with whichever runtime you prefer — all three are first-class:

<details open>
<summary><strong>Bun</strong> (recommended for speed)</summary>

```bash
bun install
```
</details>

<details>
<summary><strong>npm</strong></summary>

```bash
npm install
```
</details>

<details>
<summary><strong>pnpm</strong></summary>

```bash
pnpm install
```
</details>

---

## ⚡ Quick Start

### 1. Start the dashboard

```bash
bun run dev      # or: npm run dev / pnpm dev
```

Open [http://localhost:7777](http://localhost:7777) and you'll land on the marketing home — click
**Open dashboard** to head into the app.

### 2. Register your repos

In the **Apps** tab, click **Auto-detect** to scan siblings of the bridge folder, or **Add app**
to register a path by hand. Set per-app git policy with the gear icon (branch mode, auto-commit,
auto-push).

### 3. Create your first task

Hit **+ New task** in the header (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>N</kbd>), describe what
you want done in plain prose, and submit. The coordinator picks the right repo(s), spawns child
agents, streams their output live, and aggregates a report when they finish.

---

## ⚙️ Configuration

### Environment variables

Optional — the bridge runs with sensible defaults out of the box.

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_PORT` | `7777` | Port the dashboard + API listen on |
| `PORT` | (falls back to `BRIDGE_PORT`) | Standard Next.js port |
| `BRIDGE_URL` | `http://localhost:<port>` | Override origin when running behind a reverse proxy |
| `CLAUDE_BIN` | `claude` | Override the Claude CLI binary path |

Create a `.env` file at the bridge root if you want to set any of these:

```env
BRIDGE_PORT=7777
```

### Apps registry

The apps roster lives in `~/.claude/bridge.json` (per-machine, edited via the bridge UI). Storing
it outside the project tree means a `git pull` on the bridge can never overwrite it. The
coordinator only dispatches into folders listed there.

### Permissions

By default, agents run with `bypassPermissions` so they don't hang on the first tool call. Toggle
the per-tool approval flow per session in the UI — settings persist as allowlists you can review
and edit later.

---

## 📜 Scripts

| Script | Purpose |
|---|---|
| `dev` | Start the Next.js dev server (with `.env` loaded) |
| `build` | Production build |
| `start` | Run the production build on port 7777 |
| `serve` | `build` then `start` in one command |
| `test` | Run the test suite via Vitest |
| `test:watch` | Vitest in watch mode |
| `lint` | Run ESLint |

Run any of them with your preferred runtime:

```bash
bun run <script>     # or: npm run <script> / pnpm <script>
```

---

## 🗂️ Workspace Shape

The bridge expects to live alongside your app repos:

```
<parent>/
├── app-web/          your frontend (any stack)
├── app-api/          your backend (any stack)
├── app-shared/       any other sibling repo
└── claude-bridge/    this project
```

---

## ❓ FAQ

<details>
<summary><strong>Is this a fork or replacement of Claude Code?</strong></summary>

No. The bridge *uses* the Claude Code CLI you already have. It spawns `claude -p` processes in
the right working directory, captures their output, and adds a coordinator + dashboard layer on
top.
</details>

<details>
<summary><strong>Does it work with monorepos?</strong></summary>

It works *next to* a monorepo today (treat the monorepo root as one "app"). First-class support
for Nx / Turbo / pnpm workspaces is on the roadmap.
</details>

<details>
<summary><strong>Will my code leave my machine?</strong></summary>

Only what Claude Code itself sends — the bridge is a local Next.js app on `localhost:7777`. No
telemetry, no analytics. The apps registry lives in `~/.claude/bridge.json` on disk.
</details>

<details>
<summary><strong>What happens if an agent fails?</strong></summary>

It auto-retries once with the failure transcript injected into a fix agent. If that also fails,
the task moves to `BLOCKED` and the dashboard shows the stack of attempts so you can decide
what to do.
</details>

<details>
<summary><strong>Can I bring my own coordinator prompt?</strong></summary>

Yes — `bridge/coordinator.md` is just a prompt template you can edit. The bridge loads it on every
coordinator spawn.
</details>

---

## 🗺️ Roadmap

- [ ] LLM-assisted repo profile summaries (currently heuristic-only)
- [ ] More retry strategies than single-shot auto-retry
- [ ] Read-only public dashboard mode for stakeholders
- [ ] First-class support for monorepo workspaces (Nx, Turbo, pnpm workspaces)
- [ ] Built-in cost / token usage analytics per task
- [ ] Plugin system for custom agent roles

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

Please keep changes runtime-agnostic — anything you add should run identically under Bun, npm, and
pnpm. Tests use Vitest; the test runner is the same regardless of your local runtime.

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
