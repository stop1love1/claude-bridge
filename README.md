<p align="center">
  <img src="public/logo.jpg" alt="Claude Bridge" width="128" />
</p>

<h1 align="center">Claude Bridge</h1>

<p align="center">
  A coordinator dashboard for running Claude Code agents across multiple sibling repositories — one UI to dispatch tasks, monitor live agent runs, gate permissions, and aggregate reports.
</p>

Drop the bridge folder next to your app repos and a single dashboard handles cross-repo task management, agent dispatch, live monitoring, and reporting — without locking you into any project naming, stack, or runtime.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Workspace Shape](#workspace-shape)
- [Docker](#docker)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Multi-repo agent orchestration.** A coordinator agent decides which repos a task touches and spawns child agents (coder, reviewer, fixer, surveyor, …) directly inside the right working directory.
- **Auto-detect any project layout.** Scans sibling folders for Next.js, NestJS, Prisma, Express, Vue, Svelte, Tailwind, Python, Go, Rust, Java, and more — no hardcoded project names.
- **Task lifecycle in the UI.** Tasks move through `TODO → DOING → DONE / BLOCKED` with one click, each with a stable id, body, and an agent run tree.
- **Live monitoring.** Token-level streaming of every agent's output, instant SSE status updates, and a per-task agent tree showing parent/child relationships.
- **Permission control.** Risky tool calls (Bash, Edit, Write, Delete, …) can be gated behind a per-task popup that pauses the agent until you allow or deny — with reusable per-tool, per-pattern allowlists.
- **Resilience.** Auto-retry once on failure with the failure context injected into the fix agent. Stale-run reaper keeps the dashboard honest.
- **Session continuation.** Open any past session and pick up the conversation with full transcript replay.
- **Markdown registers.** `decisions.md`, `bugs.md`, `questions.md`, `schema.md`, `contracts/` capture cross-repo agreements the coordinator reads before planning.
- **Runtime-agnostic.** Runs identically under Bun, npm, or pnpm.

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

### Using Bun (recommended for speed)

```bash
bun install
```

### Using npm

```bash
npm install
```

### Using pnpm

```bash
pnpm install
```

---

## Quick Start

### 1. Scan your workspace

The init script detects sibling repos and writes a workspace snapshot to `sessions/init.md` (gitignored).

```bash
bun run init     # or: npm run init / pnpm run init
```

The output lists every detected repo with its stack, branch, summary, and a ready-to-paste **Repos** table for `BRIDGE.md`.

### 2. Declare your repos

Open `BRIDGE.md` and update the **Repos** table with the folder names that appeared in step 1. Example:

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

Click **+ New task** in the header (or press `Ctrl/Cmd + N`), describe what you want done in plain prose, and submit. The coordinator picks the right repo(s), spawns child agents, streams their output live, and aggregates the reports when they finish.

---

## Configuration

### Environment variables

Optional — the bridge runs with sensible defaults out of the box.

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_PORT` | `7777` | Port the dashboard + API listen on |
| `PORT` | (falls back to `BRIDGE_PORT`) | Standard Next.js port (Docker convention) |
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

Sibling paths are resolved as `../<folder-name>` — there are no hardcoded absolute paths anywhere. Rename or move freely; just keep the bridge as a sibling.

---

## Docker

A multi-stage `Dockerfile` is included. The build stage uses Bun for speed; the runtime image is plain Node with the Claude CLI on `PATH`.

```bash
docker build -t claude-bridge .
docker run -p 7777:7777 -e BRIDGE_PORT=7777 -v "$(pwd)/..:/workspace" claude-bridge
```

Mount the parent directory as `/workspace` so the bridge can reach your sibling repos from inside the container.

---

## Roadmap

- LLM-assisted repo profile summaries (currently heuristic-only)
- More retry strategies than single-shot auto-retry
- Read-only public dashboard mode for stakeholders
- First-class support for monorepo workspaces (Nx, Turbo, pnpm workspaces)

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

## License

TBD. The project is currently published without a license — please open an issue if you want to discuss usage.
