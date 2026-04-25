<p align="center">
  <img src="public/logo.svg" alt="Claude Bridge" width="128" />
</p>

<h1 align="center">Claude Bridge</h1>

<p align="center">
  <strong>One dashboard to dispatch Claude Code agents across every repo.</strong>
</p>

<p align="center">
  Coordinator UI for cross-repo task management, agent dispatch, live monitoring, and
  per-tool permission control — runtime-agnostic, stack-agnostic, no lock-in.
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
  <a href="#why-claude-bridge">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#installation">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

---

## Why Claude Bridge

You finally got Claude Code working great in *one* repo. Then a feature lands that touches three:
the API, the web client, and a shared schema package. Suddenly you're juggling terminal tabs,
copy-pasting context between sessions, and praying nothing drifts.

**Claude Bridge fixes that.** Drop it next to your repos and you get:

- **One coordinator** that reads the task, picks the right repos, and spawns child agents in each.
- **One dashboard** showing every agent's live output, status, and tool calls.
- **One permission gate** in front of risky operations — review before Claude writes.

No project naming convention. No vendor lock-in. Works on whatever stack you already have.

---

## Features

| | |
|---|---|
| **Multi-repo orchestration** | A coordinator agent decides which sibling repos a task touches and spawns coder, reviewer, and fixer agents in the right working directory. |
| **Auto-detect any stack** | Scans sibling folders for Next.js, NestJS, Prisma, Express, Vue, Svelte, Tailwind, Python, Go, Rust, Java, and more — no hardcoded project names. |
| **Task lifecycle in the UI** | Tasks move through `TODO → DOING → DONE / BLOCKED` with one click. Each task has a stable id, body, and an agent run tree. |
| **Live monitoring** | Token-level streaming of every agent's output, instant SSE status updates, and a per-task tree showing parent / child relationships. |
| **Per-tool permission control** | Risky tool calls (`Bash`, `Edit`, `Write`, `Delete`, …) gated behind a popup that pauses the agent until you allow or deny — with reusable allowlists. |
| **Resilient by default** | Auto-retry once on failure with the failure context injected into the fix agent. Stale-run reaper keeps the dashboard honest. |
| **Session continuation** | Open any past session and pick up the conversation with full transcript replay. |
| **Markdown registers** | `decisions.md`, `bugs.md`, `questions.md`, `schema.md`, `contracts/` capture cross-repo agreements the coordinator reads before planning. |
| **Runtime-agnostic** | Runs identically under Bun, npm, or pnpm. |

---

## How It Works

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

## Requirements

- **Node.js 20+** (for npm/pnpm) or **Bun 1.x**
- **Claude Code CLI** installed and authenticated. See [docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code) for setup.
- A workspace with at least one sibling app repo (any stack).

---

## Installation

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

## Quick Start

### 1. Scan your workspace

The init script detects sibling repos and writes a workspace snapshot to `sessions/init.md` (gitignored).

```bash
bun run init     # or: npm run init / pnpm run init
```

The output lists every detected repo with its stack, branch, summary, and a ready-to-paste **Repos** table for `BRIDGE.md`.

### 2. Declare your repos

Open `BRIDGE.md` and update the **Repos** table with the folder names that appeared in step 1:

```markdown
| Folder name |
|-------------|
| `app-web`   |
| `app-api`   |
```

### 3. Start the dashboard

```bash
bun run dev      # or: npm run dev / pnpm dev
```

Open [http://localhost:7777](http://localhost:7777).

### 4. Create your first task

Click **+ New task** in the header (or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>N</kbd>), describe what you want done in plain prose, and submit. The coordinator picks the right repo(s), spawns child agents, streams their output live, and aggregates the report when they finish.

---

## Configuration

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

### Repos table

`BRIDGE.md` is the canonical declaration of which sibling folders the bridge can dispatch to. The coordinator only spawns agents in folders listed there.

### Permissions

By default, agents run with `bypassPermissions` so they don't hang on the first tool call. Toggle the per-tool approval flow per session in the UI — settings persist as allowlists you can review and edit later.

---

## Scripts

| Script | Purpose |
|---|---|
| `init` | Scan sibling repos and write a snapshot to `sessions/init.md` |
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

## Workspace Shape

The bridge expects to live alongside your app repos:

```
<parent>/
├── app-web/          your frontend (any stack)
├── app-api/          your backend (any stack)
├── app-shared/       any other sibling repo
└── claude-bridge/    this project
```

---

## Roadmap

- [ ] LLM-assisted repo profile summaries (currently heuristic-only)
- [ ] More retry strategies than single-shot auto-retry
- [ ] Read-only public dashboard mode for stakeholders
- [ ] First-class support for monorepo workspaces (Nx, Turbo, pnpm workspaces)
- [ ] Built-in cost / token usage analytics per task
- [ ] Plugin system for custom agent roles

Have an idea? [Open an issue](https://github.com/stop1love1/claude-bridge/issues) — feedback shapes the roadmap.

---

## Contributing

Issues and pull requests are welcome.

```bash
# Fork, clone, branch
git checkout -b feature/<short-name>

# Run tests + lint before pushing
bun run test
bun run lint

# Open a PR against `main`
```

Please keep changes runtime-agnostic — anything you add should run identically under Bun, npm, and pnpm. Tests use Vitest; the test runner is the same regardless of your local runtime.

---

## Author

Built with care by **[@stop1love1](https://github.com/stop1love1)**.

If Claude Bridge saves you time, [a star on GitHub](https://github.com/stop1love1/claude-bridge) is the easiest way to say thanks — it helps other teams discover the project.

<a href="https://github.com/stop1love1/claude-bridge">
  <img alt="Star on GitHub" src="https://img.shields.io/github/stars/stop1love1/claude-bridge?style=social">
</a>

---

## License

TBD. The project is currently published without a license — please open an issue if you want to discuss usage.
