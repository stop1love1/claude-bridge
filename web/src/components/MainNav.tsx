import { Link, useLocation } from "react-router-dom";
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
  { key: "apps",     href: "/apps",     label: "Apps",     Icon: Boxes },
  { key: "tasks",    href: "/tasks",    label: "Tasks",    Icon: LayoutGrid },
  { key: "sessions", href: "/sessions", label: "Sessions", Icon: Terminal },
  { key: "tunnels",  href: "/tunnels",  label: "Tunnels",  Icon: Globe2 },
  { key: "settings", href: "/settings", label: "Settings", Icon: SettingsIcon },
];

/**
 * The five top-level navigations: Apps (registry), Tasks (board),
 * Sessions (raw chats), Tunnels (ngrok/localtunnel), Settings (config).
 * Renders as a horizontally scrollable pill row at every breakpoint —
 * on mobile the labels collapse to icons-only so all five fit on a
 * phone without sideways scrolling; the active tab keeps its label so
 * the user always knows where they are. `min-w-0` on the wrapper
 * prevents the row from pushing the header buttons off-screen.
 *
 * `active` highlights the current page; if omitted, the active section
 * is auto-derived from `useLocation()`. Pass `badges` for per-tab
 * counters (e.g. orphan sessions).
 */
export function MainNav({
  active,
  badges,
}: {
  /**
   * The currently-active top-level section, if any. Off-nav pages
   * (e.g. `/usage`) pass nothing so no pill gets highlighted.
   */
  active?: MainNavSection;
  badges?: Partial<Record<MainNavSection, ReactNode>>;
}) {
  const loc = useLocation();
  const auto = ITEMS.find((it) => loc.pathname.startsWith(it.href))?.key;
  const current = active ?? auto;
  return (
    <nav
      className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5 border border-border min-w-0 overflow-x-auto no-scrollbar"
      aria-label="Primary navigation"
      style={{ scrollbarWidth: "none" }}
    >
      {ITEMS.map(({ key, href, label, Icon }) => {
        const isActive = key === current;
        return (
          <Link
            key={key}
            to={href}
            aria-current={isActive ? "page" : undefined}
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 px-2 sm:px-2.5 py-1 sm:py-0.5 rounded text-xs whitespace-nowrap transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
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
