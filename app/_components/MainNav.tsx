"use client";

import Link from "next/link";
import {
  Boxes,
  ChevronDown,
  LayoutGrid,
  Settings as SettingsIcon,
  Terminal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type MainNavSection = "apps" | "tasks" | "sessions" | "settings";

const ITEMS: {
  key: MainNavSection;
  href: string;
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}[] = [
  { key: "apps",     href: "/apps",     label: "Apps",     Icon: Boxes },
  { key: "tasks",    href: "/tasks",    label: "Tasks",    Icon: LayoutGrid },
  { key: "sessions", href: "/sessions", label: "Sessions", Icon: Terminal },
  { key: "settings", href: "/settings", label: "Settings", Icon: SettingsIcon },
];

/**
 * The four top-level navigations: Apps (registry), Tasks (board),
 * Sessions (raw chats), Settings (config). On `sm+` they render as a
 * pill row in the header; on mobile they collapse into a single
 * dropdown so the user always has a way to switch sections.
 *
 * `active` highlights the current page; pass `badges` for any per-tab
 * counters (e.g. orphan sessions).
 */
export function MainNav({
  active,
  badges,
}: {
  active: MainNavSection;
  badges?: Partial<Record<MainNavSection, React.ReactNode>>;
}) {
  const activeItem = ITEMS.find((i) => i.key === active) ?? ITEMS[0];
  const ActiveIcon = activeItem.Icon;

  return (
    <>
      {/* Mobile: compact dropdown so nav stays reachable when the pill
          row would overflow the header. Trigger shows the active
          section + chevron; opening it lists every section. */}
      <div className="sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch section"
              className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-xs bg-secondary border border-border text-foreground hover:bg-accent"
            >
              <ActiveIcon size={12} />
              <span className="font-medium">{activeItem.label}</span>
              {badges?.[activeItem.key]}
              <ChevronDown size={12} className="text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {ITEMS.map(({ key, href, label, Icon }) => {
              const isActive = key === active;
              return (
                <DropdownMenuItem key={key} asChild>
                  <Link
                    href={href}
                    aria-current={isActive ? "page" : undefined}
                    className={isActive ? "bg-accent text-foreground" : undefined}
                  >
                    <Icon size={12} className="text-muted-foreground" />
                    <span>{label}</span>
                    {badges?.[key]}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop / tablet: existing pill row. Even the active section
          stays a Link so clicking it from a sub-page (e.g. /tasks/<id>)
          returns to the section index. */}
      <nav className="hidden sm:flex items-center bg-secondary rounded-md p-0.5 border border-border">
        {ITEMS.map(({ key, href, label, Icon }) => {
          const isActive = key === active;
          const cls = isActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground";
          return (
            <Link
              key={key}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs ${cls}`}
            >
              <Icon size={12} />
              {label}
              {badges?.[key]}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
