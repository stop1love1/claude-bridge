import { NavLink } from "react-router-dom";
import {
  Boxes,
  Globe2,
  LayoutGrid,
  Settings as SettingsIcon,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type MainNavSection = "apps" | "tasks" | "sessions" | "tunnels" | "settings";

const ITEMS: {
  key: MainNavSection;
  href: string;
  label: string;
  Icon: LucideIcon;
}[] = [
  { key: "apps",     href: "/apps",     label: "apps",     Icon: Boxes },
  { key: "tasks",    href: "/tasks",    label: "tasks",    Icon: LayoutGrid },
  { key: "sessions", href: "/sessions", label: "sessions", Icon: Terminal },
  { key: "tunnels",  href: "/tunnels",  label: "tunnels",  Icon: Globe2 },
  { key: "settings", href: "/settings", label: "settings", Icon: SettingsIcon },
];

/**
 * Top-level five-section navigation rendered as a horizontally
 * scrollable pill row. Mobile collapses labels to icons-only so all
 * five fit on a phone without sideways scrolling; the active tab
 * keeps its label so the operator always knows where they are.
 *
 * `min-w-0` on the wrapper lets the scrollable nav shrink instead
 * of pushing the theme/token buttons off-screen on narrow viewports.
 */
export function MainNav({
  badges,
}: {
  badges?: Partial<Record<MainNavSection, ReactNode>>;
}) {
  return (
    <nav
      className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 min-w-0 overflow-x-auto"
      aria-label="Primary navigation"
      style={{ scrollbarWidth: "none" }}
    >
      {ITEMS.map(({ key, href, label, Icon }) => (
        <NavLink
          key={key}
          to={href}
          end={false}
          aria-label={label}
          title={label}
          className={({ isActive }) =>
            cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 sm:px-2.5 font-mono text-micro uppercase tracking-wideish whitespace-nowrap transition-colors",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon size={13} />
              <span className={isActive ? "inline" : "hidden sm:inline"}>{label}</span>
              {!isActive && badges?.[key]}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
