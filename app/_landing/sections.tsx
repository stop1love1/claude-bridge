import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  PlayCircle,
  Rocket,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Workflow,
} from "lucide-react";
import { Button } from "../_components/ui/button";
import {
  AUTHOR_URL,
  FEATURES,
  GithubIcon,
  HIGHLIGHTS,
  QUICK_LINKS,
  REPO_URL,
  STACK,
  STATS,
  STEPS,
} from "./constants";

const SECTION = "px-4 sm:px-6 lg:px-8";
const CONTAINER = "max-w-5xl mx-auto";
const CONTAINER_NARROW = "max-w-4xl mx-auto";

function SectionEyebrow({
  icon: Icon,
  children,
}: {
  icon: typeof ScrollText;
  children: React.ReactNode;
}) {
  return (
    <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium uppercase tracking-wider mb-3">
      <Icon size={11} />
      {children}
    </div>
  );
}

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 h-12 shrink-0 border-b border-border bg-card/80 backdrop-blur supports-backdrop-filter:bg-card/60">
      <div className={`${CONTAINER} h-full ${SECTION} flex items-center gap-3`}>
        <Link href="/" className="flex items-center gap-2 shrink-0" title="Home">
          <Image
            src="/logo.svg"
            alt="Claude Bridge"
            width={20}
            height={20}
            className="rounded-sm"
            priority
          />
          <span className="text-sm font-semibold">Claude Bridge</span>
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
              <GithubIcon size={12} />
              <span className="hidden sm:inline">GitHub</span>
              <Star size={11} className="hidden sm:inline opacity-70" />
            </a>
          </Button>
          <Button asChild size="xs">
            <Link href="/apps">
              <span className="hidden sm:inline">Open dashboard</span>
              <span className="sm:hidden">Open</span>
              <ArrowRight size={12} />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--color-primary)_0%,transparent_60%)] opacity-20"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 -z-10 h-px bg-linear-to-r from-transparent via-primary/40 to-transparent"
      />
      <div className={`${CONTAINER_NARROW} ${SECTION} py-16 sm:py-20 md:py-28 text-center`}>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-secondary/60 hover:border-primary/40 hover:bg-secondary text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <Sparkles size={12} className="text-primary" />
          <span className="hidden sm:inline">Built for Claude Code agents</span>
          <span className="sm:hidden">For Claude Code</span>
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
          className="mx-auto mb-6 rounded-md drop-shadow-[0_0_30px_rgba(106,168,255,0.25)] w-16 h-16 sm:w-[88px] sm:h-[88px]"
          priority
        />
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight mb-5 leading-[1.1]">
          One dashboard to dispatch{" "}
          <span className="bg-linear-to-r from-primary via-info to-primary bg-clip-text text-transparent">
            Claude
          </span>
          <br className="hidden sm:block" /> across every repo.
        </h1>
        <p className="max-w-2xl mx-auto text-sm sm:text-base text-muted-foreground mb-8 leading-relaxed">
          Drop the bridge next to your app folders and a single UI handles cross-repo task
          management, agent dispatch, live monitoring, and permission control — runtime-agnostic,
          stack-agnostic, no lock-in.
        </p>
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-2 mb-8">
          <Button asChild size="default" className="w-full sm:w-auto">
            <Link href="/apps">
              <Rocket size={14} />
              Get started
              <ArrowRight size={14} />
            </Link>
          </Button>
          <Button asChild variant="outline" size="default" className="w-full sm:w-auto">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <GithubIcon size={14} />
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
  );
}

export function HighlightStrip() {
  return (
    <section className="border-b border-border bg-card/40">
      <div className={`${CONTAINER} ${SECTION} py-5 grid grid-cols-2 md:grid-cols-4 gap-3`}>
        {HIGHLIGHTS.map(({ Icon, label }) => (
          <div key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon size={14} className="text-primary shrink-0" />
            <span className="truncate">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Features() {
  return (
    <section id="features" className={`${CONTAINER} ${SECTION} py-12 sm:py-16 scroll-mt-16`}>
      <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-10">
        <SectionEyebrow icon={ScrollText}>Features</SectionEyebrow>
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3">
          Everything you need to ship across repos.
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          A single dashboard plus a coordinator agent — purpose-built for the moment a task
          spans more than one codebase.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ Icon, title, body }) => (
          <article
            key={title}
            className="group relative rounded-lg border border-border bg-card p-5 transition-all hover:border-primary/40 hover:-translate-y-0.5"
          >
            <div className="w-9 h-9 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center mb-3 group-hover:bg-primary/15 transition-colors">
              <Icon size={18} className="text-primary" />
            </div>
            <h3 className="text-sm font-semibold mb-1.5">{title}</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Stats() {
  return (
    <section className="border-y border-border bg-linear-to-b from-card/0 via-card/40 to-card/0">
      <div className={`${CONTAINER} ${SECTION} py-10 grid grid-cols-2 md:grid-cols-4 gap-6`}>
        {STATS.map(({ value, label }) => (
          <div key={label} className="text-center">
            <div className="text-2xl sm:text-3xl font-semibold tracking-tight bg-linear-to-r from-primary to-info bg-clip-text text-transparent">
              {value}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section id="how" className="border-b border-border bg-card/40 scroll-mt-16">
      <div className={`${CONTAINER} ${SECTION} py-12 sm:py-16`}>
        <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-10">
          <SectionEyebrow icon={PlayCircle}>How it works</SectionEyebrow>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3">
            Three steps from clone to coordinated agents.
          </h2>
        </div>
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map(({ n, title, body, code }) => (
            <li key={n} className="rounded-lg border border-border bg-background p-5 relative">
              <div className="font-mono text-xs text-primary/70 mb-2">{n}</div>
              <h3 className="text-sm font-semibold mb-1.5">{title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">{body}</p>
              {code && (
                <pre className="rounded-md border border-border bg-secondary/40 p-2.5 overflow-x-auto">
                  <code className="text-[11px] font-mono text-foreground/90">{code}</code>
                </pre>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Preview() {
  return (
    <section id="preview" className={`${CONTAINER} ${SECTION} py-12 sm:py-16 scroll-mt-16`}>
      <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-10">
        <SectionEyebrow icon={Terminal}>Inside the dashboard</SectionEyebrow>
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3">
          Watch agents work, in real time.
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every task expands into a tree of child agents. Streamed output. Pausable tool
          calls. No more guessing what your AI is doing in another window.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-2xl shadow-primary/5">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/50">
          <span className="w-2.5 h-2.5 rounded-full bg-destructive/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-success/70" />
          <span className="ml-3 text-[11px] font-mono text-muted-foreground truncate">
            localhost:7777/tasks/t_20260425_001
          </span>
        </div>
        <div className="p-3 sm:p-5 grid gap-3 md:grid-cols-[1.4fr_1fr]">
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="font-mono text-[10px] text-fg-dim">t_20260425_001</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-info/15 border border-info/30 text-info text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                DOING
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground whitespace-nowrap">2 agents running</span>
            </div>
            <h4 className="text-sm font-semibold mb-1">Bump auth lib + update callers</h4>
            <p className="text-xs text-muted-foreground mb-4">
              Touches <code className="font-mono text-foreground">app-api</code> and{" "}
              <code className="font-mono text-foreground">app-web</code>.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/40 border border-border/60">
                <Workflow size={13} className="text-primary shrink-0" />
                <span className="font-mono text-[11px] truncate">coordinator</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-success shrink-0">
                  <CheckCircle2 size={11} />
                  planned
                </span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/40 border border-border/60 ml-3 sm:ml-4">
                <Terminal size={13} className="text-info shrink-0" />
                <span className="font-mono text-[11px] truncate">coder · app-api</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-info shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                  streaming
                </span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/40 border border-border/60 ml-3 sm:ml-4">
                <Terminal size={13} className="text-info shrink-0" />
                <span className="font-mono text-[11px] truncate">coder · app-web</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-info shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                  streaming
                </span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/20 border border-dashed border-border/60 ml-3 sm:ml-4 opacity-60">
                <ShieldCheck size={13} className="text-warning shrink-0" />
                <span className="font-mono text-[11px]">reviewer</span>
                <span className="ml-auto text-[10px] text-muted-foreground">queued</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border bg-secondary/40 flex items-center gap-2">
              <Terminal size={12} className="text-info shrink-0" />
              <span className="font-mono text-[10px] text-muted-foreground truncate">
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
  );
}

export function QuickLinks() {
  return (
    <section className={`${CONTAINER} ${SECTION} pb-12 sm:pb-16`}>
      <div className="flex items-center gap-2 mb-5">
        <ArrowRight size={16} className="text-primary" />
        <h2 className="text-base font-semibold">Jump in</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {QUICK_LINKS.map(({ href, label, description, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
  );
}

export function FinalCTA() {
  return (
    <section className="border-t border-border">
      <div className={`${CONTAINER_NARROW} ${SECTION} py-12 sm:py-16 text-center`}>
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 border border-primary/20 mb-5">
          <Rocket size={20} className="text-primary" />
        </div>
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3">
          Stop juggling repos. Start dispatching.
        </h2>
        <p className="max-w-xl mx-auto text-sm text-muted-foreground mb-7 leading-relaxed">
          Free, open source, and runs identically on Bun, npm, or pnpm. Clone, run, ship.
        </p>
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-2">
          <Button asChild size="default" className="w-full sm:w-auto">
            <Link href="/apps">
              Open the dashboard
              <ArrowRight size={14} />
            </Link>
          </Button>
          <Button asChild variant="outline" size="default" className="w-full sm:w-auto">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <GithubIcon size={14} />
              Star on GitHub
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t border-border bg-card">
      <div
        className={`${CONTAINER} ${SECTION} py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground`}
      >
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
            <GithubIcon size={13} />
            <span className="hidden sm:inline">github.com/stop1love1/claude-bridge</span>
            <span className="sm:hidden">GitHub</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
