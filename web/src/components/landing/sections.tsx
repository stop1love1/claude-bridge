import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  HelpCircle,
  Menu,
  PlayCircle,
  Rocket,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AUTHOR_URL,
  FAQS,
  FEATURES,
  HIGHLIGHTS,
  QUICK_LINKS,
  REPO_URL,
  STACK,
  STATS,
  STEPS,
} from "./constants";

/**
 * Landing-page sections (Hero, Features, Stats, How-it-works, Preview,
 * QuickLinks, FAQ, FinalCTA, header, footer).
 *
 * Ported from `app/_landing/sections.tsx` on `main`. Adaptations:
 *   - `next/link` → `react-router-dom` `<Link to=>`
 *   - `next/image` → plain `<img>` (logo lives in `web/public/logo.svg`)
 *   - Tailwind v4-only utilities (`bg-linear-to-*`, `bg-size-*`,
 *     `mask-*`, named `peer-checked/<id>` variants) rewritten for v3
 *   - Auth-redirect / `DEMO_MODE` gating dropped — the SPA always
 *     renders the full landing page; if the operator is already
 *     authed they just click "Open dashboard"
 */

const SECTION = "px-4 sm:px-6 lg:px-8";
const CONTAINER = "max-w-5xl mx-auto";
const CONTAINER_NARROW = "max-w-4xl mx-auto";

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

const NAV_LINKS = [
  { href: "/#features", label: "Features", external: false },
  { href: "/#how", label: "How it works", external: false },
  { href: "/#preview", label: "Preview", external: false },
  { href: "/#faq", label: "FAQ", external: false },
  { href: "/docs", label: "Docs", external: false },
];

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 h-12 shrink-0 border-b border-border bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className={`${CONTAINER} h-full ${SECTION} flex items-center gap-2 sm:gap-3`}>
        <Link to="/" className="flex items-center gap-2 shrink-0 min-w-0" title="Home">
          <img src="/logo.svg" alt="Claude Bridge" width={20} height={20} className="rounded-sm" />
          <span className="text-sm font-semibold truncate">Claude Bridge</span>
        </Link>
        <nav className="hidden md:flex items-center gap-1 ml-2 text-xs text-muted-foreground">
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="px-2 py-1 rounded-sm hover:text-foreground hover:bg-accent/40 transition-colors"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
          <Button asChild variant="ghost" size="xs" title="View source on GitHub">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
            >
              <GithubIcon size={12} />
              <span className="hidden sm:inline">GitHub</span>
              <Star size={11} className="hidden sm:inline opacity-70" />
            </a>
          </Button>
          <Button asChild size="xs">
            <Link to="/tasks">
              <span className="hidden sm:inline">Open dashboard</span>
              <span className="sm:hidden">Open</span>
              <ArrowRight size={12} />
            </Link>
          </Button>
          <details className="md:hidden relative group">
            <summary
              className="list-none flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
              aria-label="Open navigation menu"
            >
              <Menu size={14} />
            </summary>
            <nav className="absolute right-0 top-full mt-1 min-w-[180px] rounded-md border border-border bg-card shadow-lg p-1 z-40">
              {NAV_LINKS.map(({ href, label }) => (
                <a
                  key={href}
                  href={href}
                  className="block px-3 py-2 text-xs rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  {label}
                </a>
              ))}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Subtle dot grid + radial glow + bottom hairline build the
          production-feel backdrop without competing with foreground copy.
          v3 note: the dot-grid mask used in main was a Tailwind v4-only
          `mask-*` utility — we drop it and rely on the radial glow alone,
          which still reads as a glow against the dotted backdrop. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--primary)_0%,transparent_60%)] opacity-20"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-[0.12] bg-[radial-gradient(circle_at_1px_1px,var(--primary)_1px,transparent_0)] bg-[length:24px_24px]"
        style={{
          // Soft fade so the dots don't extend all the way to the edges.
          WebkitMaskImage:
            "radial-gradient(ellipse at top, black 20%, transparent 70%)",
          maskImage:
            "radial-gradient(ellipse at top, black 20%, transparent 70%)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 -z-10 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />
      <div className={`${CONTAINER_NARROW} ${SECTION} py-12 sm:py-20 md:py-28 text-center`}>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex max-w-full items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1 rounded-full border border-border bg-secondary/60 hover:border-primary/40 hover:bg-secondary text-[10px] sm:text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-5 sm:mb-6"
        >
          <Sparkles size={12} className="text-primary shrink-0" />
          <span className="hidden sm:inline">Built for Claude Code agents</span>
          <span className="sm:hidden">For Claude Code</span>
          <span className="text-fg-dim">·</span>
          <span className="inline-flex items-center gap-1 shrink-0">
            <Star size={11} className="text-warning" />
            <span className="hidden sm:inline">Star on GitHub</span>
            <span className="sm:hidden">Star</span>
          </span>
          <ArrowRight
            size={11}
            className="opacity-60 transition-transform group-hover:translate-x-0.5 shrink-0"
          />
        </a>
        <img
          src="/logo.svg"
          alt="Claude Bridge"
          width={88}
          height={88}
          className="mx-auto mb-5 sm:mb-6 rounded-md drop-shadow-[0_0_30px_rgba(106,168,255,0.25)] w-14 h-14 sm:w-[88px] sm:h-[88px]"
        />
        <h1 className="text-[1.75rem] sm:text-4xl md:text-5xl font-semibold tracking-tight mb-4 sm:mb-5 leading-[1.1] text-balance">
          One dashboard to dispatch{" "}
          <span className="bg-gradient-to-r from-primary via-info to-primary bg-clip-text text-transparent">
            Claude
          </span>
          <br className="hidden sm:block" /> across every repo.
        </h1>
        <p className="max-w-2xl mx-auto text-sm sm:text-base text-muted-foreground mb-7 sm:mb-8 leading-relaxed text-pretty">
          Drop the bridge next to your app folders and a single UI handles cross-repo task
          management, agent dispatch, live monitoring, and permission control — runtime-agnostic,
          stack-agnostic, no lock-in.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 mb-5 sm:mb-6 text-[10px] sm:text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={12} className="text-success" /> Free &amp; open source
          </span>
          <span className="text-fg-dim">·</span>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={12} className="text-success" /> Self-hosted, your code stays local
          </span>
          <span className="hidden sm:inline text-fg-dim">·</span>
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <CheckCircle2 size={12} className="text-success" /> Bun · npm · pnpm
          </span>
        </div>
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-2 mb-7 sm:mb-8">
          <Button asChild size="default" className="w-full sm:w-auto">
            <Link to="/tasks">
              <Rocket size={14} />
              Get started
              <ArrowRight size={14} />
            </Link>
          </Button>
          <Button asChild variant="outline" size="default" className="w-full sm:w-auto">
            <Link to="/docs">
              <ScrollText size={14} />
              Read the docs
            </Link>
          </Button>
          <Button asChild variant="ghost" size="default" className="hidden sm:inline-flex">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <GithubIcon size={14} />
              Star on GitHub
            </a>
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-3 sm:gap-x-4 gap-y-1.5 sm:gap-y-2 text-[10px] sm:text-[11px] text-muted-foreground">
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
      <div
        className={`${CONTAINER} ${SECTION} py-5 grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3`}
      >
        {HIGHLIGHTS.map(({ Icon, label }) => (
          <div
            key={label}
            className="flex items-center gap-2 text-[11px] sm:text-xs text-muted-foreground"
          >
            <Icon size={14} className="text-primary shrink-0" />
            <span className="leading-snug">{label}</span>
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
          A single dashboard plus a coordinator agent — purpose-built for the moment a task spans
          more than one codebase.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ Icon, title, body }) => (
          <article
            key={title}
            className="group relative rounded-lg border border-border bg-card p-4 sm:p-5 transition-all hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5"
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
    <section className="border-y border-border bg-gradient-to-b from-card/0 via-card/40 to-card/0">
      <div
        className={`${CONTAINER} ${SECTION} py-8 sm:py-10 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-6`}
      >
        {STATS.map(({ value, label }) => (
          <div key={label} className="text-center min-w-0">
            <div className="text-2xl sm:text-3xl md:text-[2rem] font-semibold tracking-tight bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">
              {value}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground leading-relaxed text-balance">
              {label}
            </div>
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
            <li
              key={n}
              className="rounded-lg border border-border bg-background p-4 sm:p-5 relative flex flex-col"
            >
              <div className="font-mono text-xs text-primary/70 mb-2">{n}</div>
              <h3 className="text-sm font-semibold mb-1.5">{title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3 flex-1">{body}</p>
              {code && (
                <pre className="rounded-md border border-border bg-secondary/40 p-2.5 overflow-x-auto max-w-full">
                  <code className="text-[10.5px] sm:text-[11px] font-mono text-foreground/90 whitespace-pre">
                    {code}
                  </code>
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
          Every task expands into a tree of child agents. Streamed output. Pausable tool calls. No
          more guessing what your AI is doing in another window.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-2xl shadow-primary/5">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/50 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-destructive/70 shrink-0" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning/70 shrink-0" />
          <span className="w-2.5 h-2.5 rounded-full bg-success/70 shrink-0" />
          <span className="ml-2 sm:ml-3 text-[10px] sm:text-[11px] font-mono text-muted-foreground truncate min-w-0">
            localhost:7777/tasks/t_20260425_001
          </span>
        </div>
        <div className="p-3 sm:p-5 grid gap-3 md:grid-cols-[1.4fr_1fr]">
          <div className="rounded-lg border border-border bg-background p-3 sm:p-4 min-w-0">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="font-mono text-[10px] text-fg-dim">t_20260425_001</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-info/15 border border-info/30 text-info text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                DOING
              </span>
              <span className="sm:ml-auto text-[10px] text-muted-foreground whitespace-nowrap">
                2 agents running
              </span>
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

          <div className="rounded-lg border border-border bg-background overflow-hidden min-w-0">
            <div className="px-3 py-1.5 border-b border-border bg-secondary/40 flex items-center gap-2 min-w-0">
              <Terminal size={12} className="text-info shrink-0" />
              <span className="font-mono text-[10px] text-muted-foreground truncate min-w-0">
                coder · app-api · stream
              </span>
            </div>
            <pre className="p-3 text-[10.5px] sm:text-[11px] font-mono leading-relaxed overflow-x-auto">
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
            to={href}
            className="group rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/40 hover:bg-accent/40 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Icon size={16} className="text-primary shrink-0" />
              <span className="text-sm font-semibold truncate">{label}</span>
              <ArrowRight
                size={12}
                className="ml-auto shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
              />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * CSS-only runtime tab control.
 *
 * The original used Tailwind v4's `peer-checked/<id>:` named-peer
 * variants — those don't exist in v3. We instead drive each tab strip
 * via `:has(:checked)` selectors expressed as arbitrary variants on
 * the radio's *label*, and reveal the matching panel with the
 * sibling-of-checked combinator. No JS, no `useState`, no
 * client-only directive needed.
 */
function RuntimeTabs() {
  const runtimes = [
    { id: "npm", label: "npm", install: "npm install", serve: "npm run serve" },
    { id: "pnpm", label: "pnpm", install: "pnpm install", serve: "pnpm run serve" },
    { id: "bun", label: "Bun", install: "bun install", serve: "bun run serve" },
  ] as const;

  return (
    <div className="max-w-md mx-auto mb-3">
      {/* Hidden radios — must precede the tab strip + panels so the
          ~ general-sibling combinator in `index.css` can resolve from
          a checked radio to its matching tab + panel. `defaultChecked`
          on npm makes it the initially-active tab. */}
      <input
        type="radio"
        name="bridge-runtime"
        id="bridge-rt-npm"
        defaultChecked
        className="sr-only"
      />
      <input
        type="radio"
        name="bridge-runtime"
        id="bridge-rt-pnpm"
        className="sr-only"
      />
      <input
        type="radio"
        name="bridge-runtime"
        id="bridge-rt-bun"
        className="sr-only"
      />

      {/* Tab strip. The active state is driven by global CSS in
          `index.css` (`#bridge-rt-<id>:checked ~ ... [data-tab="<id>"]`)
          since Tailwind v3 has no named-peer variants. */}
      <div
        className="flex items-stretch p-1 rounded-md border border-border bg-card/80 backdrop-blur mb-2"
        role="tablist"
        aria-label="Pick a runtime"
      >
        {runtimes.map(({ id, label }) => (
          <label
            key={id}
            htmlFor={`bridge-rt-${id}`}
            role="tab"
            className="flex-1 text-center text-xs font-medium py-1.5 rounded-sm cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
            data-tab={id}
          >
            {label}
          </label>
        ))}
      </div>

      {/* Panels — hidden by default, revealed via the `:checked ~`
          rules in `index.css`. */}
      {runtimes.map(({ id, install, serve }) => (
        <div
          key={id}
          role="tabpanel"
          aria-labelledby={`bridge-rt-${id}`}
          data-runtime-panel={id}
          className="hidden rounded-md border border-border bg-card/80 backdrop-blur overflow-hidden text-left"
        >
          <div className="p-3 space-y-1.5 font-mono text-[11px] sm:text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-success select-none shrink-0">$</span>
              <code className="truncate text-foreground">{install}</code>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-success select-none shrink-0">$</span>
              <code className="truncate text-foreground">{serve}</code>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function FAQ() {
  return (
    <section id="faq" className="border-t border-border bg-card/40 scroll-mt-16">
      <div className={`${CONTAINER_NARROW} ${SECTION} py-12 sm:py-16`}>
        <div className="text-center max-w-2xl mx-auto mb-7 sm:mb-9">
          <SectionEyebrow icon={HelpCircle}>FAQ</SectionEyebrow>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3 text-balance">
            Questions teams ask before they ship.
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Short answers to the things people email about most. The{" "}
            <Link
              to="/docs#faq"
              className="text-foreground hover:text-primary underline-offset-4 hover:underline"
            >
              docs
            </Link>{" "}
            cover the long ones.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden shadow-sm">
          {FAQS.map(({ q, a }, i) => (
            <details key={q} className="group" {...(i === 0 ? { open: true } : {})}>
              <summary className="flex items-start gap-3 px-4 sm:px-5 py-3.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-accent/40 transition-colors">
                <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-mono shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-sm font-medium text-foreground flex-1 leading-snug">{q}</span>
                <ArrowRight
                  size={14}
                  className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="px-4 sm:px-5 pb-4 pl-12 sm:pl-13 -mt-1 text-xs sm:text-[13px] text-muted-foreground leading-relaxed text-pretty">
                {a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCTA() {
  return (
    <section className="relative overflow-hidden border-t border-border">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_bottom,var(--primary)_0%,transparent_60%)] opacity-15"
      />
      <div className={`${CONTAINER_NARROW} ${SECTION} py-14 sm:py-20 text-center`}>
        <div className="inline-flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-primary/10 border border-primary/20 mb-4 sm:mb-5">
          <Rocket size={20} className="text-primary" />
        </div>
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3 text-balance">
          Stop juggling repos. Start dispatching.
        </h2>
        <p className="max-w-xl mx-auto text-sm text-muted-foreground mb-6 sm:mb-7 leading-relaxed text-pretty">
          Free, open source, and runs identically on Bun, npm, or pnpm. Clone, run, ship.
        </p>
        <RuntimeTabs />
        <div className="text-[10px] sm:text-[11px] text-fg-dim text-center mb-6 sm:mb-7">
          Production build + start · port 7777 · setup happens in the browser
        </div>
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-2">
          <Button asChild size="default" className="w-full sm:w-auto">
            <Link to="/tasks">
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
          <Button asChild variant="ghost" size="default" className="w-full sm:w-auto">
            <Link to="/docs">
              <ScrollText size={14} />
              Read the docs
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function LandingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-card">
      <div className={`${CONTAINER} ${SECTION} py-8 sm:py-10`}>
        <div className="grid gap-6 sm:gap-8 sm:grid-cols-2 md:grid-cols-4 text-[12px] sm:text-xs">
          <div className="sm:col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-2">
              <img src="/logo.svg" alt="" width={20} height={20} className="rounded-sm" />
              <span className="text-sm font-semibold text-foreground">Claude Bridge</span>
            </div>
            <p className="text-muted-foreground leading-relaxed text-pretty">
              Hand off the task. Go grab a coffee. We&apos;ll ping you when it ships.
            </p>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-medium mb-2.5">
              Product
            </div>
            <ul className="space-y-1.5 text-muted-foreground">
              <li>
                <a href="/#features" className="hover:text-foreground transition-colors">
                  Features
                </a>
              </li>
              <li>
                <a href="/#how" className="hover:text-foreground transition-colors">
                  How it works
                </a>
              </li>
              <li>
                <a href="/#preview" className="hover:text-foreground transition-colors">
                  Preview
                </a>
              </li>
              <li>
                <a href="/#faq" className="hover:text-foreground transition-colors">
                  FAQ
                </a>
              </li>
            </ul>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-medium mb-2.5">
              Resources
            </div>
            <ul className="space-y-1.5 text-muted-foreground">
              <li>
                <Link to="/docs" className="hover:text-foreground transition-colors">
                  Documentation
                </Link>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/issues`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                >
                  Report an issue
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}#-roadmap`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                >
                  Roadmap
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/releases`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                >
                  Releases
                </a>
              </li>
            </ul>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-medium mb-2.5">
              Project
            </div>
            <ul className="space-y-1.5 text-muted-foreground">
              <li>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  <GithubIcon size={12} />
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href={AUTHOR_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                >
                  Author
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/blob/main/README.md`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                >
                  README
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/blob/main/LICENSE`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                >
                  License
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-7 pt-5 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-muted-foreground text-center sm:text-left">
          <span>
            © {year} Claude Bridge · built by{" "}
            <a
              href={AUTHOR_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground font-medium hover:text-primary"
            >
              @stop1love1
            </a>
          </span>
          <span className="inline-flex items-center gap-1.5 text-fg-dim">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            Open source · self-hosted · no telemetry
          </span>
        </div>
      </div>
    </footer>
  );
}
