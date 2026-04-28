import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Globe2,
  HelpCircle,
  KeyRound,
  Network,
  Package,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Button } from "../_components/ui/button";
import { LandingFooter, LandingHeader } from "../_landing/sections";
import { GithubIcon, REPO_URL } from "../_landing/constants";

export const metadata: Metadata = {
  title: "Docs · Claude Bridge",
  description:
    "Install, configure, and operate Claude Bridge — the cross-repo coordinator for Claude Code.",
};

const SECTION = "px-4 sm:px-6 lg:px-8";
const CONTAINER = "max-w-6xl mx-auto";

type TocEntry = { id: string; label: string; Icon: typeof BookOpen };

const TOC: TocEntry[] = [
  { id: "install", label: "Install", Icon: Package },
  { id: "quick-start", label: "Quick start", Icon: ArrowRight },
  { id: "architecture", label: "Architecture", Icon: Network },
  { id: "configuration", label: "Configuration", Icon: Settings2 },
  { id: "auth", label: "Authentication", Icon: KeyRound },
  { id: "permissions", label: "Permissions", Icon: ShieldCheck },
  { id: "telegram", label: "Telegram", Icon: Send },
  { id: "tunnels", label: "Tunnels", Icon: Globe2 },
  { id: "scripts", label: "Scripts", Icon: Terminal },
  { id: "faq", label: "FAQ", Icon: HelpCircle },
];

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="text-xl sm:text-2xl font-semibold tracking-tight scroll-mt-20 mb-3"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold tracking-tight mt-6 mb-2 text-foreground">
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-muted-foreground leading-relaxed mb-3">{children}</p>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-secondary border border-border/60 text-foreground">
      {children}
    </code>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="rounded-md border border-border bg-secondary/40 p-3 overflow-x-auto mb-4">
      <code className="text-[12px] font-mono text-foreground/90 whitespace-pre">{children}</code>
    </pre>
  );
}

function DocsHero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--color-primary)_0%,transparent_60%)] opacity-15"
      />
      <div className={`${CONTAINER} ${SECTION} py-10 sm:py-14`}>
        <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium uppercase tracking-wider mb-3">
          <BookOpen size={11} />
          Docs
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mb-3 leading-[1.15]">
          Set it up once, then go grab a coffee.
        </h1>
        <p className="max-w-2xl text-sm sm:text-base text-muted-foreground leading-relaxed">
          Everything you need to install, configure, and operate Claude Bridge — the cross-repo
          coordinator for Claude Code agents. Skim the table of contents on the right to jump
          straight to what you need.
        </p>
      </div>
    </section>
  );
}

function Toc() {
  return (
    <aside className="hidden lg:block sticky top-16 self-start">
      <nav className="rounded-lg border border-border bg-card p-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2 px-1">
          On this page
        </div>
        <ul className="space-y-0.5">
          {TOC.map(({ id, label, Icon }) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
              >
                <Icon size={12} className="text-primary/70 shrink-0" />
                <span className="truncate">{label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function Install() {
  return (
    <section>
      <H2 id="install">Install</H2>
      <P>
        Clone the bridge as a <strong className="text-foreground">sibling</strong> of your app
        repos — there are no hardcoded paths anywhere, so the registry just walks the parent
        folder.
      </P>
      <Pre>{`cd <parent-folder-that-holds-your-app-repos>
git clone https://github.com/stop1love1/claude-bridge.git
cd claude-bridge`}</Pre>
      <P>
        Install dependencies with whichever runtime you prefer — Bun, npm, and pnpm are all
        first-class.
      </P>
      <Pre>{`bun install     # or: npm install / pnpm install`}</Pre>
      <P>
        Requirements: <Code>Node 20+</Code> (for npm/pnpm) or <Code>Bun 1.x</Code>, the{" "}
        <Code>claude</Code> CLI authenticated, and at least one sibling app repo of any stack.
      </P>
    </section>
  );
}

function QuickStart() {
  return (
    <section>
      <H2 id="quick-start">Quick start</H2>
      <H3>1. Start the dashboard</H3>
      <Pre>{`bun run dev      # or: npm run dev / pnpm dev`}</Pre>
      <P>
        Open <Code>http://localhost:7777</Code> and you&apos;ll land on the marketing home — click{" "}
        <strong className="text-foreground">Open dashboard</strong> to head into the app.
      </P>

      <H3>2. Register your repos</H3>
      <P>
        In the <strong className="text-foreground">Apps</strong> tab, click{" "}
        <strong className="text-foreground">Auto-detect</strong> to scan siblings, or{" "}
        <strong className="text-foreground">Add app</strong> to register a path by hand. Set
        per-app git policy with the gear icon (branch mode, auto-commit, auto-push).
      </P>

      <H3>3. Create your first task</H3>
      <P>
        Hit <strong className="text-foreground">+ New task</strong> in the header (or{" "}
        <Code>Ctrl/Cmd + N</Code>), describe the work in plain prose, and submit. The
        coordinator picks the right repo(s), spawns child agents, streams their output live,
        runs the verify chain, and aggregates a report when they finish.
      </P>

      <H3>4. Walk away</H3>
      <P>
        Pair the bridge with Telegram (see below) and you can close the laptop. Your phone
        buzzes when the task ships — or when something needs a human call. Until then: ☕ /
        🛏️ / 🍻. Your call.
      </P>
    </section>
  );
}

function Architecture() {
  return (
    <section>
      <H2 id="architecture">Architecture</H2>
      <P>
        One coordinator agent reads the task and spawns one child per repo it touches. Every
        successful child run is gated by the verify-then-ship chain before the task is marked
        shippable. Failures auto-retry once with the failure transcript injected into a fix
        agent.
      </P>
      <Pre>{`               ┌──────────────────────────┐
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
                  └──────────────────┘`}</Pre>
      <P>
        Sibling paths are resolved as <Code>../&lt;folder-name&gt;</Code>. Rename or move
        freely, just keep the bridge as a sibling of your app folders.
      </P>
    </section>
  );
}

function Configuration() {
  const envVars: { name: string; def: string; purpose: string }[] = [
    { name: "BRIDGE_PORT", def: "7777", purpose: "Port the dashboard + API listen on (PORT also honored)" },
    { name: "BRIDGE_URL", def: "http://localhost:<port>", purpose: "Origin spawned children + webhooks call back to" },
    { name: "BRIDGE_DEMO_MODE", def: "—", purpose: "1 = landing-only mode; dashboard + APIs return 503" },
    { name: "CLAUDE_BIN", def: "claude", purpose: "Override the Claude CLI binary path" },
    { name: "ALLOWED_DEV_ORIGINS", def: "—", purpose: "Comma-separated origins allowed to hit the dev server" },
    { name: "BRIDGE_LOCK_VERIFY", def: "0", purpose: "1 = reject API edits to per-app verify commands" },
    { name: "BRIDGE_TRUSTED_PROXY", def: "0", purpose: "1 = trust XFF headers when behind a proxy" },
    { name: "NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS", def: "—", purpose: "Single-user opt-in for composer bypass mode" },
  ];
  return (
    <section>
      <H2 id="configuration">Configuration</H2>
      <P>
        Optional — the bridge runs with sensible defaults. See <Code>.env.example</Code> for the
        annotated full list.
      </P>
      <H3>Environment variables</H3>
      <div className="rounded-lg border border-border overflow-hidden mb-4">
        <table className="w-full text-xs">
          <thead className="bg-secondary/50 text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Variable</th>
              <th className="text-left px-3 py-2 font-medium">Default</th>
              <th className="text-left px-3 py-2 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody>
            {envVars.map((v) => (
              <tr key={v.name} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-foreground whitespace-nowrap">{v.name}</td>
                <td className="px-3 py-2 font-mono text-fg-dim whitespace-nowrap">{v.def}</td>
                <td className="px-3 py-2 text-muted-foreground">{v.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H3>Apps registry</H3>
      <P>
        The roster lives in <Code>~/.claude/bridge.json</Code> (per-machine, edited via the
        bridge UI). Storing it outside the project tree means a <Code>git pull</Code> on the
        bridge can never overwrite it. Each entry can carry:
      </P>
      <ul className="text-sm text-muted-foreground leading-relaxed mb-3 ml-5 list-disc space-y-1">
        <li>
          <Code>git</Code> — branch policy (<Code>current</Code> / <Code>fixed</Code> /{" "}
          <Code>auto-create</Code>), worktree mode, <Code>autoCommit</Code>, <Code>autoPush</Code>
        </li>
        <li>
          <Code>verify</Code> — shell commands run after every successful child run (
          <Code>test</Code>, <Code>lint</Code>, <Code>build</Code>, …)
        </li>
        <li>
          <Code>pinnedFiles</Code> — paths the coordinator should always include in child prompts
        </li>
        <li>
          <Code>quality</Code> — thresholds for the verify-chain critics
        </li>
        <li>
          <Code>description</Code>, <Code>capabilities</Code> — free-text routing metadata
        </li>
      </ul>
    </section>
  );
}

function Auth() {
  return (
    <section>
      <H2 id="auth">Authentication</H2>
      <P>
        The bridge is a single-operator dashboard. On first run it redirects to{" "}
        <Code>/login?setup=1</Code> to set a password (scrypt hash, N=131072, stored in{" "}
        <Code>~/.claude/bridge.json</Code> with mode <Code>0600</Code>). Subsequent visits issue
        an HMAC-signed session cookie; the optional &ldquo;trust this device&rdquo; path saves
        a 30-day cookie that&apos;s revocable per device from <Code>/settings</Code>. CSRF is
        enforced via <Code>Sec-Fetch-Site</Code>, with <Code>Origin</Code> /{" "}
        <Code>Referer</Code> host equality as a fallback for older clients; login attempts are
        rate-limited and the cookie is <Code>SameSite=Lax</Code>, <Code>HttpOnly</Code>, and{" "}
        <Code>Secure</Code> in production.
      </P>
      <P>
        If you also configure Telegram, login attempts from a fresh device can require approval
        from the operator&apos;s chat — useful when the bridge is exposed beyond <Code>localhost</Code>.
      </P>
      <Pre>{`bun run set:password         # set or rotate the password
bun run telegram:login       # one-shot Telegram approval flow (optional)`}</Pre>
    </section>
  );
}

function Permissions() {
  return (
    <section>
      <H2 id="permissions">Permissions</H2>
      <P>
        By default, agents run in <Code>default</Code> mode for user-typed messages — every
        tool call (<Code>Bash</Code>, <Code>Edit</Code>, <Code>Write</Code>,{" "}
        <Code>Delete</Code>, …) pauses behind an inline Allow / Deny popup. Coordinator and
        auto-spawned children run in bypass mode (otherwise they&apos;d hang on the first tool
        call).
      </P>
      <P>
        Settings persist as a reusable allowlist per session. On a single-user localhost setup
        you can opt the composer into bypass too via{" "}
        <Code>NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS=1</Code>; the env gate is mirrored on the server
        so a deploy that toggles it off rejects spoofed bypass requests.
      </P>
    </section>
  );
}

function Telegram() {
  return (
    <section>
      <H2 id="telegram">Telegram</H2>
      <P>
        Configure once in <Code>/settings → Telegram</Code> and you can drive the bridge from
        anywhere — the reason &ldquo;hand off the task and walk away&rdquo; actually works.
      </P>
      <H3>Bot channel</H3>
      <P>
        Paste a bot token; the bridge listens for <Code>/new</Code>, <Code>/list</Code>,{" "}
        <Code>/status</Code>, <Code>/report</Code>, <Code>/tail</Code>, <Code>/kill</Code>,{" "}
        <Code>/delete</Code>, <Code>/done</Code>, … plus free-text NL routing for matching
        intents. Notifications fire on every task transition (<Code>spawned</Code> /{" "}
        <Code>done</Code> / <Code>failed</Code> / <Code>stale</Code>) to a configured chat id.
      </P>
      <H3>User-client channel (optional)</H3>
      <P>
        Pair the operator&apos;s own Telegram account as a private DM channel. Requires a numeric
        user id to dispatch — an <Code>@username</Code> alone is refused so a random DM
        can&apos;t trigger commands.
      </P>
    </section>
  );
}

function Tunnels() {
  return (
    <section>
      <H2 id="tunnels">Tunnels</H2>
      <P>
        The <Code>/tunnels</Code> page exposes a local port to the public internet for demos,
        webhook testing, or sharing a dev preview from the bridge itself. Two providers ship
        out of the box:
      </P>
      <ul className="text-sm text-muted-foreground leading-relaxed mb-3 ml-5 list-disc space-y-1">
        <li>
          <strong className="text-foreground">localtunnel</strong> — runs via{" "}
          <Code>bunx localtunnel</Code>. Free, no signup, slightly slower, shows an
          interstitial password page on first visit per IP. Custom subdomains are
          honoured. URL host: <Code>*.loca.lt</Code>.
        </li>
        <li>
          <strong className="text-foreground">ngrok</strong> — faster, no interstitial,
          needs a free authtoken from{" "}
          <Code>dashboard.ngrok.com/get-started/your-authtoken</Code>. The bridge
          one-click installs ngrok via <Code>winget</Code> (Windows),{" "}
          <Code>brew</Code> (macOS), or the official tarball (Linux / mac without brew),
          and persists the authtoken in <Code>~/.claude/bridge.json</Code> with mode{" "}
          <Code>0600</Code>. URL host: <Code>*.ngrok-free.app</Code>.
        </li>
      </ul>
      <P>
        Tunnels are in-memory only — every entry dies when the bridge process exits, and
        restarting the bridge clears the list. Up to 8 concurrent tunnels per bridge
        instance; the page surfaces install state, authtoken state, and live stdout for
        each running tunnel.
      </P>
      <P>
        Anyone with the URL can reach the port — don&apos;t expose services without auth
        in front. Demo-mode deployments (<Code>BRIDGE_DEMO_MODE=1</Code>) redirect{" "}
        <Code>/tunnels</Code> back to <Code>/</Code> alongside the rest of the dashboard.
      </P>
    </section>
  );
}

function Scripts() {
  const scripts: { name: string; purpose: string }[] = [
    { name: "dev", purpose: "Start the Next.js dev server (with .env loaded)" },
    { name: "build", purpose: "Production build" },
    { name: "start", purpose: "Run the production build on port 7777" },
    { name: "serve", purpose: "build then start in one command" },
    { name: "test", purpose: "Run the test suite via Vitest" },
    { name: "test:watch", purpose: "Vitest in watch mode" },
    { name: "lint", purpose: "Run ESLint" },
    { name: "set:password", purpose: "Set or rotate the operator password" },
    { name: "telegram:login", purpose: "One-shot interactive Telegram user-client login" },
    { name: "approve:login", purpose: "Approve a pending login attempt from another device" },
  ];
  return (
    <section>
      <H2 id="scripts">Scripts</H2>
      <div className="rounded-lg border border-border overflow-hidden mb-4">
        <table className="w-full text-xs">
          <thead className="bg-secondary/50 text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Script</th>
              <th className="text-left px-3 py-2 font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody>
            {scripts.map((s) => (
              <tr key={s.name} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-foreground whitespace-nowrap">{s.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>
        Run any of them with your preferred runtime:{" "}
        <Code>bun run &lt;script&gt;</Code> /{" "}
        <Code>npm run &lt;script&gt;</Code> /{" "}
        <Code>pnpm &lt;script&gt;</Code>.
      </P>
    </section>
  );
}

function Faq() {
  const items: { q: string; a: React.ReactNode }[] = [
    {
      q: "Is this a fork or replacement of Claude Code?",
      a: (
        <>
          No. The bridge <em>uses</em> the Claude Code CLI you already have. It spawns{" "}
          <Code>claude -p</Code> processes in the right working directory, captures their
          output, and adds a coordinator + dashboard layer on top.
        </>
      ),
    },
    {
      q: "Does it work with monorepos?",
      a: (
        <>
          It works <em>next to</em> a monorepo today (treat the monorepo root as one
          &ldquo;app&rdquo;). First-class support for Nx / Turbo / pnpm workspaces is on the
          roadmap.
        </>
      ),
    },
    {
      q: "Will my code leave my machine?",
      a: (
        <>
          Only what Claude Code itself sends — the bridge is a local Next.js app on{" "}
          <Code>localhost:7777</Code>. No telemetry, no analytics. The apps registry lives in{" "}
          <Code>~/.claude/bridge.json</Code> on disk.
        </>
      ),
    },
    {
      q: "What happens if an agent fails?",
      a: (
        <>
          The verify chain runs every successful child through preflight, semantic,
          style-critic, and your app&apos;s <Code>test</Code> / <Code>lint</Code> /{" "}
          <Code>build</Code>. On failure the bridge auto-retries once with the failure
          transcript fed to a fix agent. If the retry still fails, the task stays in{" "}
          <Code>DOING</Code> with the failure surfaced in the run tree.
        </>
      ),
    },
    {
      q: "How do I drive the bridge from my phone?",
      a: (
        <>
          Configure Telegram in <Code>/settings → Telegram</Code>. You&apos;ll then spawn tasks (
          <Code>/new …</Code>), monitor (<Code>/status</Code>, <Code>/list</Code>,{" "}
          <Code>/tail</Code>), kill runs, read reports, and approve cross-device logins from
          any chat — with a numeric chat-id allowlist so random DMs are ignored.
        </>
      ),
    },
    {
      q: "Can I bring my own coordinator prompt?",
      a: (
        <>
          Yes — <Code>bridge/coordinator.md</Code> is just a prompt template you can edit. The
          bridge loads it on every coordinator spawn.
        </>
      ),
    },
  ];
  return (
    <section>
      <H2 id="faq">FAQ</H2>
      <div className="space-y-2">
        {items.map(({ q, a }) => (
          <details
            key={q}
            className="group rounded-lg border border-border bg-card p-4 open:bg-card/80 transition-colors"
          >
            <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-medium select-none">
              <ArrowRight
                size={14}
                className="text-primary transition-transform group-open:rotate-90 shrink-0"
              />
              <span>{q}</span>
            </summary>
            <div className="mt-3 text-sm text-muted-foreground leading-relaxed">{a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="rounded-xl border border-border bg-linear-to-br from-primary/10 via-card to-card p-6 sm:p-8 mt-12">
      <h2 className="text-xl sm:text-2xl font-semibold tracking-tight mb-2">
        Ready to hand off the next task?
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mb-5 max-w-xl">
        Open the dashboard, describe the work, and let the coordinator do the running around.
      </p>
      <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
        <Button asChild size="default">
          <Link href="/apps">
            Open the dashboard
            <ArrowRight size={14} />
          </Link>
        </Button>
        <Button asChild variant="outline" size="default">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            <GithubIcon size={14} />
            Star on GitHub
          </a>
        </Button>
      </div>
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <LandingHeader />
      <main className="flex-1">
        <DocsHero />
        <div className={`${CONTAINER} ${SECTION} py-10 sm:py-14`}>
          <div className="grid gap-8 lg:grid-cols-[1fr_220px]">
            <div className="min-w-0 space-y-12">
              <Install />
              <QuickStart />
              <Architecture />
              <Configuration />
              <Auth />
              <Permissions />
              <Telegram />
              <Tunnels />
              <Scripts />
              <Faq />
              <Cta />
            </div>
            <Toc />
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
