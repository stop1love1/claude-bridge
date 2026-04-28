"use client";

import Link from "next/link";
import {
  Boxes,
  Globe2,
  LayoutGrid,
  Settings as SettingsIcon,
  Terminal,
} from "lucide-react";

export type MainNavSection = "apps" | "tasks" | "sessions" | "tunnels" | "settings";

const ITEMS: {
  key: MainNavSection;
  href: string;
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}[] = [
  { key: "apps",     href: "/apps",     label: "Apps",     Icon: Boxes },
  { key: "tasks",    href: "/tasks",    label: "Tasks",    Icon: LayoutGrid },
  { key: "sessions", href: "/sessions", label: "Sessions", Icon: Terminal },
  { key: "tunnels",  href: "/tunnels",  label: "Tunnels",  Icon: Globe2 },
  { key: "settings", href: "/settings", label: "Settings", Icon: SettingsIcon },
];

/**
 * The four top-level navigations: Apps (registry), Tasks (board),
 * Sessions (raw chats), Settings (config). Renders as a horizontally
 * scrollable pill row at every breakpoint — on mobile the labels
 * collapse to icons-only so all sections fit on a phone without
 * sideways scrolling; the active tab keeps its label so the user
 * always knows where they are. `min-w-0` on the wrapper prevents the
 * row from pushing the header buttons off-screen.
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
  return (
    <nav
      className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5 border border-border min-w-0 overflow-x-auto no-scrollbar"
      aria-label="Primary navigation"
    >
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
            aria-label={label}
            title={label}
            className={`inline-flex shrink-0 items-center gap-1 px-2 sm:px-2.5 py-1 sm:py-0.5 rounded text-xs whitespace-nowrap ${cls}`}
          >
            <Icon size={13} />
            <span className={isActive ? "inline" : "hidden sm:inline"}>{label}</span>
            {!isActive && badges?.[key]}
          </Link>
        );
      })}
    </nav>
  );
}
