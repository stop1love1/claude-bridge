import { Link, NavLink, useLocation } from "react-router-dom";
import { useHealth, useTasksMeta } from "@/api/queries";
import { cn } from "@/lib/cn";

// Sticky chrome. Wordmark + counter + connection status. The connection
// dot collapses three states into a single glance:
//   green  — /api/health 200
//   amber  — 401 (no/expired token)
//   red    — fetch error / network down
function connState(
  isError: boolean,
  data: { status: string } | undefined,
): { color: string; label: string } {
  if (data?.status === "ok") return { color: "bg-status-done", label: "online" };
  if (isError) return { color: "bg-status-blocked", label: "offline" };
  return { color: "bg-status-doing", label: "auth" };
}

export default function Header() {
  const { data: health, isError } = useHealth();
  const { data: tasks } = useTasksMeta();
  const loc = useLocation();
  const conn = connState(isError, health);
  const total = tasks?.tasks.length ?? 0;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-8 px-6">
        <Link to="/" className="group flex items-center gap-3">
          <span
            aria-hidden
            className="block h-2.5 w-2.5 rotate-45 bg-accent transition-transform duration-300 group-hover:rotate-[135deg]"
          />
          <span className="font-mono text-[13px] font-semibold tracking-wideish uppercase">
            claude<span className="text-muted">/</span>bridge
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          <NavItem to="/" active={loc.pathname === "/"} label="board" />
          <NavItem
            to="/settings"
            active={loc.pathname.startsWith("/settings")}
            label="settings"
          />
        </nav>

        <div className="ml-auto flex items-center gap-6">
          <span className="font-mono text-micro uppercase tracking-wideish text-muted">
            <span className="text-fg tnum">{String(total).padStart(2, "0")}</span>
            <span className="px-1.5 text-muted-2">·</span>
            tasks
          </span>
          {health?.version && (
            <span className="hidden font-mono text-micro tracking-wideish text-muted-2 md:inline">
              v{health.version}
            </span>
          )}
          <div
            className="flex items-center gap-2 font-mono text-micro uppercase tracking-wideish text-muted"
            title={`bridge ${conn.label}`}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", conn.color)} />
            {conn.label}
          </div>
        </div>
      </div>
    </header>
  );
}

function NavItem({
  to,
  active,
  label,
}: {
  to: string;
  active: boolean;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      className={cn(
        "px-2 py-1 font-mono text-micro uppercase tracking-wideish transition-colors",
        active ? "text-fg" : "text-muted hover:text-fg",
      )}
    >
      {label}
    </NavLink>
  );
}
