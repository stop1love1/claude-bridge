import { Link } from "react-router-dom";
import { Monitor, Moon, Sun } from "lucide-react";
import { MainNav, type MainNavSection } from "@/components/MainNav";
import { useTheme, type ThemePref } from "@/components/ThemeProvider";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Global top-of-page header — strictly cross-page chrome:
 *
 *   [Brand] [MainNav]                       [Theme] [User]
 *
 * Page-specific filters / breadcrumbs / action buttons belong in a
 * per-page sub-toolbar rendered just below this header. Keeping that
 * stuff out of here means the global row never has to flex around
 * variable content and never overflows on narrow viewports.
 *
 * Mirrors main's HeaderShell: 44px row, card surface, logo + brand,
 * MainNav, theme picker, UserMenu.
 */
export function HeaderShell({
  active,
  badges,
}: {
  /** Omit on off-nav pages (e.g. /usage) so no top-nav pill highlights. */
  active?: MainNavSection;
  badges?: Partial<Record<MainNavSection, React.ReactNode>>;
}) {
  const { pref, resolved, setPref, mounted } = useTheme();

  // Pre-mount, render a stable Monitor icon so the very first paint
  // matches the no-flash bootstrap. After mount, swap to the icon
  // that reflects the user's actual preference.
  const Icon = !mounted
    ? Monitor
    : pref === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  const tooltip = !mounted
    ? "Theme menu"
    : pref === "system"
      ? `Theme: system (currently ${resolved})`
      : `Theme: ${pref}`;

  return (
    <header className="sticky top-0 z-40 h-11 shrink-0 px-2 sm:px-3 border-b border-border bg-card flex items-center gap-2 sm:gap-3">
      <Link to="/" className="flex items-center gap-2 shrink-0" title="Home">
        <img
          src="/logo.svg"
          alt="Claude Bridge"
          width={20}
          height={20}
          className="rounded-sm"
        />
        <h1 className="hidden md:inline text-sm font-semibold">Claude Bridge</h1>
      </Link>

      {/* min-w-0 lets the scrollable nav shrink instead of pushing the
          theme/user buttons off-screen on narrow viewports. */}
      <div className="flex-1 min-w-0">
        <MainNav active={active} badges={badges} />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="iconSm"
            title={tooltip}
            aria-label="Theme menu"
            className="text-fg-dim hover:text-foreground"
          >
            <Icon size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuRadioGroup
            value={mounted ? pref : "system"}
            onValueChange={(v) => setPref(v as ThemePref)}
          >
            <DropdownMenuRadioItem value="system">
              <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
              <span>System</span>
              <span className="ml-auto text-[10px] text-muted-foreground capitalize">
                {resolved}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">
              <Sun className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Light</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Dark</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <UserMenu />
    </header>
  );
}
