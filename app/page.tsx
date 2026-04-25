import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  GitBranch,
  LayoutGrid,
  PlayCircle,
  Rocket,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { Button } from "./_components/ui/button";

function Github({ size = 16, className }: { size?: number; className?: string }) {
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

const FEATURES: { Icon: typeof Workflow; title: string; body: string }[] = [
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
    body: "Tasks move through TODO → DOING → DONE / BLOCKED with one click — each with a stable id, body, and an agent run tree.",
  },
  {
    Icon: Terminal,
    title: "Live monitoring",
    body: "Token-level streaming of every agent's output, instant SSE status updates, and a per-task tree showing parent / child agent relationships.",
  },
  {
    Icon: ShieldCheck,
    title: "Permission control",
    body: "Risky tool calls (Bash, Edit, Write, Delete, …) gated behind a popup that pauses the agent until you allow or deny — with reusable allowlists.",
  },
  {
    Icon: Sparkles,
    title: "Resilient by default",
    body: "Auto-retry once on failure with the failure context injected into the fix agent. Stale-run reaper keeps the dashboard honest.",
  },
];

const STEPS: { n: string; title: string; body: string; code?: string }[] = [
  {
    n: "01",
    title: "Drop in next to your repos",
    body: "Clone the bridge as a sibling of your app folders. Zero hardcoded paths — it discovers everything from disk.",
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
    body: "Coordinator picks the right repo(s), spawns child agents, streams their output live, and aggregates the report when they finish.",
    code: '"Bump the auth lib in app-api and update its callers in app-web."',
  },
];

const HIGHLIGHTS: { Icon: typeof Zap; label: string }[] = [
  { Icon: Zap, label: "Live token streaming" },
  { Icon: ShieldCheck, label: "Per-tool permission gates" },
  { Icon: Workflow, label: "Coordinator → child agent tree" },
  { Icon: GitBranch, label: "Branch-aware dispatch" },
];

const QUICK_LINKS: {
  href: string;
  label: string;
  description: string;
  Icon: typeof Boxes;
}[] = [
  {
    href: "/apps",
    label: "Apps",
    description: "Registered sibling repos",
    Icon: Boxes,
  },
  {
    href: "/tasks",
    label: "Tasks",
    description: "Board for cross-repo work",
    Icon: LayoutGrid,
  },
  {
    href: "/sessions",
    label: "Sessions",
    description: "Raw Claude transcripts",
    Icon: Terminal,
  },
];

const STACK = ["Next.js 16", "TypeScript", "Tailwind v4", "Bun · npm · pnpm", "Claude Code"];

const REPO_URL = "https://github.com/stop1love1/claude-bridge";
const AUTHOR_URL = "https://github.com/stop1love1";

export default function HomePage() {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-30 h-11 shrink-0 px-3 border-b border-border bg-card/80 backdrop-blur flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 shrink-0" title="Home">
          <Image
            src="/logo.svg"
            alt="Claude Bridge"
            width={20}
            height={20}
            className="rounded-sm"
            priority
          />
          <h1 className="text-sm font-semibold">Claude Bridge</h1>
          <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-full bg-secondary border border-border text-[9px] font-medium text-muted-foreground uppercase tracking-wider">
            Open Source
          </span>
        </Link>
        <nav className="hidden md:flex items-center gap-1 ml-2 text-xs text-muted-foreground">
          <a href="#features" className="px-2 py-1 hover:text-foreground transition-colors">Features</a>
          <a href="#how" className="px-2 py-1 hover:text-foreground transition-colors">How it works</a>
          <a href="#preview" className="px-2 py-1 hover:text-foreground transition-colors">Preview</a>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Button asChild variant="ghost" size="xs" title="View source on GitHub">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <Github size={12} />
              <span className="hidden sm:inline">GitHub</span>
              <Star size={11} className="hidden sm:inline opacity-70" />
            </a>
          </Button>
          <Button asChild size="xs">
            <Link href="/apps">
              Open dashboard
              <ArrowRight size={12} />
            </Link>
          </Button>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--color-primary)_0%,transparent_60%)] opacity-20"
          />
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 -z-10 h-px bg-linear-to-r from-transparent via-primary/40 to-transparent"
          />
          <div className="max-w-4xl mx-auto px-6 py-20 md:py-28 text-center">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-secondary/60 hover:border-primary/40 hover:bg-secondary text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-6"
            >
              <Sparkles size={12} className="text-primary" />
              Built for Claude Code agents
              <span className="text-fg-dim">·</span>
              <span className="inline-flex items-center gap-1">
                <Star size={11} className="text-warning" />
                Star on GitHub
              </span>
              <ArrowRight size={11} className="opacity-60 transition-transform group-hover:translate-x-0.5" />
            </a>
            <Image
              src="/logo.svg"
              alt="Claude Bridge"
              width={88}
              height={88}
              className="mx-auto mb-6 rounded-md drop-shadow-[0_0_30px_rgba(106,168,255,0.25)]"
              priority
            />
            <h2 className="text-4xl md:text-5xl font-semibold tracking-tight mb-5 leading-[1.1]">
              One dashboard to dispatch{" "}
              <span className="bg-linear-to-r from-primary via-info to-primary bg-clip-text text-transparent">
                Claude
              </span>
              <br className="hidden sm:block" /> across every repo.
            </h2>
            <p className="max-w-2xl mx-auto text-sm md:text-base text-muted-foreground mb-8 leading-relaxed">
              Drop the bridge next to your app folders and a single UI handles cross-repo task
              management, agent dispatch, live monitoring, and permission control — runtime-agnostic,
              stack-agnostic, no lock-in.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
              <Button asChild size="default">
                <Link href="/apps">
                  <Rocket size={14} />
                  Get started
                  <ArrowRight size={14} />
                </Link>
              </Button>
              <Button asChild variant="outline" size="default">
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  <Github size={14} />
                  Star on GitHub
                </a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
              {STACK.map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-primary/60" />
                  {s}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Highlight strip */}
        <section className="border-b border-border bg-card/40">
          <div className="max-w-5xl mx-auto px-6 py-5 grid grid-cols-2 md:grid-cols-4 gap-3">
            {HIGHLIGHTS.map(({ Icon, label }) => (
              <div key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon size={14} className="text-primary shrink-0" />
                <span className="truncate">{label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="max-w-5xl mx-auto px-6 py-16 scroll-mt-12">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium uppercase tracking-wider mb-3">
              <ScrollText size={11} />
              Features
            </div>
            <h3 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">
              Everything you need to ship across repos.
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A single dashboard plus a coordinator agent — purpose-built for the moment a task
              spans more than one codebase.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ Icon, title, body }) => (
              <div
                key={title}
                className="group relative rounded-lg border border-border bg-card p-5 transition-all hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-[0_0_0_1px_var(--color-primary)]/10"
              >
                <div className="w-9 h-9 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center mb-3 group-hover:bg-primary/15 transition-colors">
                  <Icon size={18} className="text-primary" />
                </div>
                <h4 className="text-sm font-semibold mb-1.5">{title}</h4>
                <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="border-y border-border bg-card/40 scroll-mt-12">
          <div className="max-w-5xl mx-auto px-6 py-16">
            <div className="text-center max-w-2xl mx-auto mb-10">
              <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium uppercase tracking-wider mb-3">
                <PlayCircle size={11} />
                How it works
              </div>
              <h3 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">
                Three steps from clone to coordinated agents.
              </h3>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {STEPS.map(({ n, title, body, code }) => (
                <div
                  key={n}
                  className="rounded-lg border border-border bg-background p-5 relative"
                >
                  <div className="font-mono text-xs text-primary/70 mb-2">{n}</div>
                  <h4 className="text-sm font-semibold mb-1.5">{title}</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed mb-3">{body}</p>
                  {code && (
                    <pre className="rounded-md border border-border bg-secondary/40 p-2.5 overflow-x-auto">
                      <code className="text-[11px] font-mono text-foreground/90">{code}</code>
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Mock product preview */}
        <section id="preview" className="max-w-5xl mx-auto px-6 py-16 scroll-mt-12">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium uppercase tracking-wider mb-3">
              <Terminal size={11} />
              Inside the dashboard
            </div>
            <h3 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">
              Watch agents work, in real time.
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Every task expands into a tree of child agents. Streamed output. Pausable tool
              calls. No more guessing what your AI is doing in another window.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden shadow-2xl shadow-primary/5">
            {/* fake window chrome */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/50">
              <span className="w-2.5 h-2.5 rounded-full bg-destructive/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-warning/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-success/70" />
              <span className="ml-3 text-[11px] font-mono text-muted-foreground">
                localhost:7777/tasks/t_20260425_001
              </span>
            </div>
            <div className="p-5 grid gap-3 md:grid-cols-[1.4fr_1fr]">
              <div className="rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-mono text-[10px] text-fg-dim">t_20260425_001</span>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-info/15 border border-info/30 text-info text-[10px] font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                    DOING
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">2 agents running</span>
                </div>
                <h5 className="text-sm font-semibold mb-1">Bump auth lib + update callers</h5>
                <p className="text-xs text-muted-foreground mb-4">
                  Touches <code className="font-mono text-foreground">app-api</code> and{" "}
                  <code className="font-mono text-foreground">app-web</code>.
                </p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/40 border border-border/60">
                    <Workflow size={13} className="text-primary" />
                    <span className="font-mono text-[11px]">coordinator</span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-success">
                      <CheckCircle2 size={11} />
                      planned
                    </span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/40 border border-border/60 ml-4">
                    <Terminal size={13} className="text-info" />
                    <span className="font-mono text-[11px]">coder · app-api</span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-info">
                      <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                      streaming
                    </span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/40 border border-border/60 ml-4">
                    <Terminal size={13} className="text-info" />
                    <span className="font-mono text-[11px]">coder · app-web</span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-info">
                      <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                      streaming
                    </span>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/20 border border-dashed border-border/60 ml-4 opacity-60">
                    <ShieldCheck size={13} className="text-warning" />
                    <span className="font-mono text-[11px]">reviewer</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">queued</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-background p-0 overflow-hidden">
                <div className="px-3 py-1.5 border-b border-border bg-secondary/40 flex items-center gap-2">
                  <Terminal size={12} className="text-info" />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    coder · app-api · stream
                  </span>
                </div>
                <pre className="p-3 text-[11px] font-mono leading-relaxed overflow-hidden">
                  <code>
                    <span className="text-fg-dim">$ </span>
                    <span className="text-foreground">read package.json</span>
                    {"\n"}
                    <span className="text-success">→ found @company/auth@2.4.1</span>
                    {"\n"}
                    <span className="text-fg-dim">$ </span>
                    <span className="text-foreground">edit package.json</span>
                    {"\n"}
                    <span className="text-warning">! tool gate: write</span>
                    {"\n"}
                    <span className="text-success">  approved (allowlist)</span>
                    {"\n"}
                    <span className="text-success">→ bumped to ^3.0.0</span>
                    {"\n"}
                    <span className="text-fg-dim">$ </span>
                    <span className="text-foreground">grep callers</span>
                    <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-primary animate-pulse" />
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </section>

        {/* Quick links */}
        <section className="max-w-5xl mx-auto px-6 pb-16">
          <div className="flex items-center gap-2 mb-5">
            <ArrowRight size={16} className="text-primary" />
            <h3 className="text-base font-semibold">Jump in</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {QUICK_LINKS.map(({ href, label, description, Icon }) => (
              <Link
                key={href}
                href={href}
                className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon size={16} className="text-primary" />
                  <span className="text-sm font-semibold">{label}</span>
                  <ArrowRight
                    size={12}
                    className="ml-auto text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{description}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-border">
          <div className="max-w-4xl mx-auto px-6 py-16 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 border border-primary/20 mb-5">
              <Rocket size={20} className="text-primary" />
            </div>
            <h3 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">
              Stop juggling repos. Start dispatching.
            </h3>
            <p className="max-w-xl mx-auto text-sm text-muted-foreground mb-7 leading-relaxed">
              Free, open source, and runs identically on Bun, npm, or pnpm. Clone, run, ship.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild size="default">
                <Link href="/apps">
                  Open the dashboard
                  <ArrowRight size={14} />
                </Link>
              </Button>
              <Button asChild variant="outline" size="default">
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  <Github size={14} />
                  Star on GitHub
                </a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Image src="/logo.svg" alt="" width={16} height={16} className="rounded-sm opacity-80" />
            <span>
              Claude Bridge — built by{" "}
              <a
                href={AUTHOR_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground font-medium hover:text-primary"
              >
                @stop1love1
              </a>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <Github size={13} />
              github.com/stop1love1/claude-bridge
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
