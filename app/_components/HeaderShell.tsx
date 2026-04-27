"use client";

import Image from "next/image";
import Link from "next/link";
import { Monitor, Moon, Sun } from "lucide-react";
import { MainNav, type MainNavSection } from "./MainNav";
import { useTheme, type ThemePref } from "./ThemeProvider";
import { UserMenu } from "./UserMenu";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * Unified top-of-page header used by every top-level (and sub-) page.
 *
 *   [Brand] [Nav]  [center — filters / breadcrumb (flex-1)]  [right — stats + actions]
 *
 * Pages put filter inputs or a breadcrumb in `children` (center, grows
 * to fill); they put stats text + primary CTAs in `actions` so the
 * right edge stays visually consistent across every page.
 */
export function HeaderShell({
  active,
  badges,
  actions,
  children,
}: {
  active: MainNavSection;
  badges?: Partial<Record<MainNavSection, React.ReactNode>>;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { pref, resolved, setPref, mounted } = useTheme();
  // Pre-mount: render a stable Monitor icon so SSR markup matches the
  // first client render. After mount, swap to the icon that reflects
  // the user's actual preference.
  const Icon = !mounted
    ? Monitor
    : pref === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  const tooltip = !mounted
    ? "Theme menu"
    : pref === "system"
      ? `Theme: system (currently ${resolved})`
      : `Theme: ${pref}`;
  return (
    <header className="h-11 shrink-0 px-3 border-b border-border bg-card flex items-center gap-3">
      <Link href="/" className="flex items-center gap-2 shrink-0" title="Home">
        <Image
          src="/logo.svg"
          alt="Claude Bridge"
          width={20}
          height={20}
          className="rounded-sm"
          priority
        />
        <h1 className="hidden md:inline text-sm font-semibold">Claude Bridge</h1>
      </Link>
      <MainNav active={active} badges={badges} />
      <div className="flex-1 flex items-center gap-2 min-w-0">{children}</div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
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
      </div>
    </header>
  );
}
