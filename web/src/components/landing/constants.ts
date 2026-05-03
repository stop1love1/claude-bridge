import {
  BookOpenCheck,
  Boxes,
  GitBranch,
  LayoutGrid,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Landing-page content constants.
 *
 * Ported verbatim from the legacy Next.js app's `app/_landing/constants.tsx`
 * so the SPA marketing surface stays text-identical to the canonical site.
 * Only the inline `GithubIcon` JSX helper was relocated to `sections.tsx`
 * (this file is now `.ts`-only — TypeScript without JSX).
 */

export type FaqItem = { q: string; a: string };

export const REPO_URL = "https://github.com/stop1love1/claude-bridge";
export const AUTHOR_URL = "https://github.com/stop1love1";

export type Feature = { Icon: LucideIcon; title: string; body: string };
export type Step = { n: string; title: string; body: string; code?: string };
export type Highlight = { Icon: LucideIcon; label: string };
export type QuickLink = {
  href: string;
  label: string;
  description: string;
  Icon: LucideIcon;
};

export const FEATURES: Feature[] = [
  {
    Icon: Workflow,
    title: "Multi-repo orchestration",
    body: "A coordinator agent decides which sibling repos a task touches and spawns coder, reviewer, and fixer agents inside the right working directory.",
  },
  {
    Icon: GitBranch,
    title: "Auto-detect any stack",
    body: "Scans sibling folders for Next.js, NestJS, Prisma, Express, Vue, Svelte, Tailwind, Python, Go, Rust, Java — no hardcoded project names.",
  },
  {
    Icon: LayoutGrid,
    title: "Task lifecycle in the UI",
    body: "Tasks flow through TODO → DOING → DONE / BLOCKED with one click — each with a stable id, body, and an agent run tree.",
  },
  {
    Icon: Terminal,
    title: "Live monitoring",
    body: "Token-level streaming of every agent's output, instant SSE status updates, and a per-task tree showing parent / child relationships.",
  },
  {
    Icon: ShieldCheck,
    title: "Per-tool permission gates",
    body: "Risky tool calls (Bash, Edit, Write, Delete, …) pause behind a popup until you allow or deny — with reusable allowlists per session.",
  },
  {
    Icon: Sparkles,
    title: "Verify-then-ship chain",
    body: "Auto-retry on failure, then run preflight, semantic, style-critic, and your own test/lint/build commands before declaring a run done. The fix agent gets the failure context injected.",
  },
  {
    Icon: Send,
    title: "Telegram bridge",
    body: "Spawn tasks, watch transitions, kill runs, or read a report from your phone. Bot + user-client channels with chat-id allowlist and natural-language command routing.",
  },
  {
    Icon: BookOpenCheck,
    title: "Cross-repo registers",
    body: "decisions.md, bugs.md, questions.md — markdown notebooks the coordinator reads before planning so cross-repo agreements outlive the AI session.",
  },
  {
    Icon: GitBranch,
    title: "Branch-aware dispatch",
    body: "Per-app git policy: stay on current branch, fix to one branch, auto-create claude/<task-id>, or spawn into a fresh worktree. Optional auto-commit + push after every successful run.",
  },
];

export const STEPS: Step[] = [
  {
    n: "01",
    title: "Drop in next to your repos",
    body: "Clone the bridge as a sibling of your app folders. Zero hardcoded paths — every repo is discovered from disk.",
    code: "git clone https://github.com/stop1love1/claude-bridge.git",
  },
  {
    n: "02",
    title: "Register your apps",
    body: "Auto-detect siblings (Next.js, NestJS, Python, Go…) or add them by hand. The registry lives outside the repo so updates can't overwrite it.",
    code: "bun run dev   # http://localhost:7777",
  },
  {
    n: "03",
    title: "Describe a task in prose",
    body: "The coordinator picks the right repo(s), spawns child agents, streams their output live, and aggregates a report when they finish.",
    code: '"Bump the auth lib in app-api and update its callers in app-web."',
  },
];

export const HIGHLIGHTS: Highlight[] = [
  { Icon: Zap, label: "Live token streaming" },
  { Icon: ShieldCheck, label: "Per-tool permission gates" },
  { Icon: Workflow, label: "Coordinator → child agent tree" },
  { Icon: Send, label: "Control from Telegram" },
];

export const QUICK_LINKS: QuickLink[] = [
  { href: "/apps", label: "Apps", description: "Registered sibling repos", Icon: Boxes },
  { href: "/tasks", label: "Tasks", description: "Board for cross-repo work", Icon: LayoutGrid },
  { href: "/sessions", label: "Sessions", description: "Raw Claude transcripts", Icon: Terminal },
];

export const STACK = [
  "Go bridge",
  "React 18 SPA",
  "Tailwind v3",
  "Bun · npm · pnpm",
  "Claude Code",
];

export const STATS: { value: string; label: string }[] = [
  { value: "0", label: "Hardcoded paths or names" },
  { value: "3", label: "Runtimes (Bun · npm · pnpm)" },
  { value: "4", label: "Verify stages before ship" },
  { value: "∞", label: "Repos coordinated per task" },
];

export const FAQS: FaqItem[] = [
  {
    q: "Where does my code go? Is anything sent to a third-party?",
    a: "The bridge runs entirely on your machine. Your repos stay on your disk; only the prompts and tool calls you'd already be making with Claude Code are sent to Anthropic. The dashboard, registry, and session transcripts are all local files.",
  },
  {
    q: "Do I need a paid Claude plan?",
    a: "You need the `claude` CLI authenticated however you'd normally use it — Anthropic API key, Claude Pro, or a workspace plan. The bridge spawns regular `claude` processes; whatever works for you in a single repo works here across many.",
  },
  {
    q: "How does it handle dangerous tool calls?",
    a: "Every Bash, Edit, Write, or Delete call pauses behind an Allow / Deny popup until you decide. You can build per-session allowlists, mark a child as bypass-trusted, or operate fully gated — your call, per task.",
  },
  {
    q: "Can multiple people use the same dashboard?",
    a: "It's designed as a single-operator console — scrypt password, signed cookie, optional trusted-device list, optional Telegram approval for new logins. For shared deployments, run it behind your VPN or reverse proxy.",
  },
  {
    q: "What stacks does the auto-detect support?",
    a: "Next.js, NestJS, Express, Vue, Svelte, Tailwind, Prisma, plus Python, Go, Rust, Java, and more. Nothing in the bridge is hardcoded to a stack — you can also register repos by hand from the UI.",
  },
  {
    q: "Will the agent push code without me reviewing it?",
    a: "Only if you've turned on auto-commit + auto-push for that specific app, and the verify chain (preflight + semantic + style + your own test/lint/build) passed. Default policy is: stay on the current branch and let you decide what to do with the diff.",
  },
];
