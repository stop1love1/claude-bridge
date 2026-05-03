import { Link } from "react-router-dom";
import { KeyRound, Monitor, Moon, Sun } from "lucide-react";
import { MainNav, type MainNavSection } from "@/components/MainNav";
import { useTheme, type ThemePref } from "@/components/ThemeProvider";
import { useTasksMeta } from "@/api/queries";
import { useConnection } from "@/lib/connection";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";

/**
 * Global top-of-page chrome:
 *
 *   [Brand] [MainNav]                 [tasks count] [conn dot] [theme] [token]
 *
 * Page-specific filters / breadcrumbs / action buttons belong in a
 * per-page sub-toolbar rendered below this header. Keeping page
 * concerns out of the global row means it never has to flex around
 * variable content and never overflows on narrow viewports.
 */
export function HeaderShell({
  badges,
}: {
  badges?: Partial<Record<MainNavSection, React.ReactNode>>;
}) {
  const { pref, resolved, setPref, mounted } = useTheme();
  const conn = useConnection();
  const { data: tasks } = useTasksMeta();
  // `useTasksMeta` returns a `TaskMetaMap` (record keyed by task id) —
  // use `Object.keys` for the count rather than `.length` on a `tasks`
  // sub-property which would only exist on the legacy list shape.
  const total = tasks ? Object.keys(tasks).length : 0;

  // Pre-mount, render a stable Monitor icon so the very first paint
  // matches the no-flash bootstrap. After mount, swap to the icon
  // that reflects the user's actual preference.
  const ThemeIcon = !mounted
    ? Monitor
    : pref === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  const themeTooltip = !mounted
    ? "Theme menu"
    : pref === "system"
      ? `theme: system (currently ${resolved})`
      : `theme: ${pref}`;

  const connColor =
    conn.state === "ok" ? "bg-status-done"
    : conn.state === "auth" ? "bg-status-doing"
    : "bg-status-blocked";
  const connLabel = conn.state === "ok" ? "online" : conn.state;

  return (
    <header className="sticky top-0 z-40 h-12 shrink-0 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-full w-full max-w-[1400px] items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Link to="/" className="group flex items-center gap-2 shrink-0" title="claude/bridge — home">
          <span
            aria-hidden
            className="block h-2.5 w-2.5 rotate-45 bg-accent transition-transform duration-300 group-hover:rotate-[135deg]"
          />
          <span className="hidden md:inline font-mono text-[13px] font-semibold tracking-wideish uppercase">
            claude<span className="text-muted">/</span>bridge
          </span>
        </Link>

        {/* min-w-0 lets the scrollable nav shrink instead of pushing
            the right-hand chrome off-screen on narrow viewports. */}
        <div className="flex-1 min-w-0">
          <MainNav badges={badges} />
        </div>

        <span
          className="hidden sm:inline font-mono text-micro uppercase tracking-wideish text-muted shrink-0"
          aria-label={`${total} tasks`}
        >
          <span className="text-fg tnum">{String(total).padStart(2, "0")}</span>
          <span className="px-1.5 text-muted-2">·</span>
          tasks
        </span>

        <div
          className="flex items-center gap-1.5 font-mono text-micro uppercase tracking-wideish text-muted shrink-0"
          title={`bridge ${connLabel}${conn.version ? ` v${conn.version}` : ""}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", connColor)} />
          <span className="hidden sm:inline">{connLabel}</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="iconSm"
              title={themeTooltip}
              aria-label="Theme menu"
            >
              <ThemeIcon size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup
              value={mounted ? pref : "system"}
              onValueChange={(v) => setPref(v as ThemePref)}
            >
              <DropdownMenuRadioItem value="system">
                <Monitor className="h-3.5 w-3.5 text-muted" />
                <span>system</span>
                <span className="ml-auto text-[10px] text-muted capitalize">
                  {resolved}
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun className="h-3.5 w-3.5 text-muted" />
                <span>light</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="h-3.5 w-3.5 text-muted" />
                <span>dark</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* No login flow — the "user menu" is just a shortcut to the
            settings page where the operator pastes their bridge token. */}
        <Button
          asChild
          variant="ghost"
          size="iconSm"
          title="bridge token (settings)"
          aria-label="Token settings"
        >
          <Link to="/settings">
            <KeyRound size={14} />
          </Link>
        </Button>
      </div>
    </header>
  );
}
