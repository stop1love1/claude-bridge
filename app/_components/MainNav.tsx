"use client";

import Link from "next/link";
import { Boxes, LayoutGrid, Settings as SettingsIcon, Terminal } from "lucide-react";

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
 * The three top-level navigations: Apps (registry), Tasks (board),
 * Sessions (raw chats). Rendered as a pill row inside the header of
 * every top-level page so users always know where they are and can
 * jump sideways with one click.
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
    <nav className="hidden sm:flex items-center bg-secondary rounded-md p-0.5 border border-border">
      {ITEMS.map(({ key, href, label, Icon }) => {
        const isActive = key === active;
        const cls = isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground";
        // Even the active section is rendered as a Link so the user can
        // always click it to navigate up — e.g. on /tasks/<id>, clicking
        // the highlighted "Tasks" tab returns to the task list. This is
        // the canonical "back to section" affordance; no extra Back
        // button needed in sub-page headers.
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
  );
}
