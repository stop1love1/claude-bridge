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

export const REPO_URL = "https://github.com/stop1love1/claude-bridge";
export const AUTHOR_URL = "https://github.com/stop1love1";

export type Feature = { Icon: LucideIcon; title: string; body: string };
export type Step = { n: string; title: string; body: string; code?: string };
export type Highlight = { Icon: LucideIcon; label: string };
export type QuickLink = { href: string; label: string; description: string; Icon: LucideIcon };

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

export const STACK = ["Next.js 16", "TypeScript", "Tailwind v4", "Bun · npm · pnpm", "Claude Code"];

export const STATS: { value: string; label: string }[] = [
  { value: "0", label: "Hardcoded paths or names" },
  { value: "3", label: "Runtimes (Bun · npm · pnpm)" },
  { value: "4", label: "Verify stages before ship" },
  { value: "∞", label: "Repos coordinated per task" },
];

export function GithubIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.17a10.97 10.97 0 0 1 5.76 0c2.2-1.48 3.16-1.17 3.16-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.08 0 4.42-2.69 5.4-5.26 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
