import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Boxes,
  Folder,
  GitBranch,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  useApps,
  useRemoveApp,
  useRepos,
  useScanApp,
  useTasks,
  useTasksMetaMap,
} from "@/api/queries";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import { AddAppDialog } from "@/components/AddAppDialog";
import { AppSettingsDialog } from "@/components/AppSettingsDialog";
import { AutoDetectDialog } from "@/components/AutoDetectDialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { App, TaskMetaMap } from "@/api/types";
import { cn } from "@/lib/cn";

interface AppStats {
  idle: number;
  doing: number;
  done: number;
  activeSessions: number;
}

const ZERO_STATS: AppStats = { idle: 0, doing: 0, done: 0, activeSessions: 0 };

/**
 * Adaptive cadence for the live counters: poll every 4 s while any run
 * for a registered app is active, otherwise back off to 15 s. Computed
 * from the meta-map so the kanban / sidebar always agrees.
 */
function pickPollInterval(metaMap: TaskMetaMap | undefined): number {
  if (!metaMap) return 15_000;
  for (const m of Object.values(metaMap)) {
    if (m.runs.some((r) => r.status === "running")) return 4_000;
  }
  return 15_000;
}

export default function AppsPage() {
  const navigate = useNavigate();
  const { data: appsData, isLoading } = useApps();
  const { data: reposData } = useRepos();
  // Drive both polls from the same cadence — the map query feeds the
  // active-session counter, the lite list feeds idle/doing/done.
  const { data: metaMap } = useTasksMetaMap(15_000);
  const cadence = pickPollInterval(metaMap);
  const tasksQuery = useTasks(cadence);
  // Re-subscribe with the live cadence whenever it flips. The hook
  // accepts a single arg, so we just pass the derived cadence on each
  // render — react-query handles the timer swap.
  const tasks = tasksQuery.data ?? [];

  const scanApp = useScanApp();
  const removeApp = useRemoveApp();
  const toast = useToast();
  const confirm = useConfirm();

  const [addOpen, setAddOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);

  const apps = appsData?.apps ?? [];
  const repos = reposData?.repos ?? [];

  const repoFor = useMemo(() => {
    const m = new Map<string, (typeof repos)[number]>();
    for (const r of repos) m.set(r.name, r);
    return m;
  }, [repos]);

  /**
   * Per-app rollups: idle = TODO, doing = DOING (BLOCKED excluded —
   * matches main), done = DONE — not yet archived. activeSessions
   * counts every running run whose `repo` matches the app name.
   */
  const statsByApp = useMemo(() => {
    const out = new Map<string, AppStats>();
    const ensure = (name: string) => {
      let s = out.get(name);
      if (!s) {
        s = { idle: 0, doing: 0, done: 0, activeSessions: 0 };
        out.set(name, s);
      }
      return s;
    };
    for (const t of tasks) {
      if (!t.app) continue;
      const s = ensure(t.app);
      if (t.section === "DONE — not yet archived") s.done += 1;
      else if (t.section === "DOING") s.doing += 1;
      else if (t.section === "TODO") s.idle += 1;
      // BLOCKED is intentionally not counted in the three buckets.
      const meta = metaMap?.[t.id];
      if (meta) {
        for (const r of meta.runs) {
          if (r.status === "running" && r.repo === t.app) s.activeSessions += 1;
        }
      }
    }
    return out;
  }, [tasks, metaMap]);

  const onScan = async (name: string) => {
    try {
      const r = await scanApp.mutateAsync(name);
      // Go bridge returns {ok, symbolCount, profile, ...}. Treat a
      // non-null profile as "scanned"; otherwise surface the symbol
      // count or a neutral "no change" toast.
      if (r.profile) {
        toast.success(
          `scanned ${name}`,
          r.symbolCount != null
            ? `${r.symbolCount} symbols indexed`
            : undefined,
        );
      } else if (r.symbolCount != null) {
        toast.info(`re-indexed ${name}`, `${r.symbolCount} symbols`);
      } else {
        toast.info(`scan returned no changes for ${name}`);
      }
    } catch (e) {
      toast.error("scan failed", (e as Error).message);
    }
  };

  const onDelete = async (name: string) => {
    const ok = await confirm({
      title: `remove ${name}?`,
      description:
        "removes the entry from the apps registry. the folder on disk is untouched.",
      confirmLabel: "remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await removeApp.mutateAsync(name);
      toast.info(`removed ${name}`);
    } catch (e) {
      toast.error("delete failed", (e as Error).message);
    }
  };

  const openTasksFor = (name: string) =>
    navigate(`/tasks?app=${encodeURIComponent(name)}`);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Boxes size={18} className="text-primary" />
            <h1 className="font-mono text-display font-semibold tracking-tightish text-foreground">
              apps
            </h1>
            <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
              {apps.length} app{apps.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-2 max-w-xl text-small text-muted-foreground">
            registered in{" "}
            <span className="font-mono text-foreground">~/.claude/bridge.json</span>.
            the coordinator dispatches agents into these folders by name.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setAddOpen(true)}>
            <Plus size={12} />
            add
          </Button>
          <Button variant="outline" onClick={() => setAutoOpen(true)}>
            <Sparkles size={12} />
            auto-detect
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-sm" />
          ))}
        </div>
      ) : apps.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="no apps registered yet"
          hint="add your first app, or run auto-detect to scan the parent directory."
          action={
            <Button onClick={() => setAddOpen(true)}>
              <Plus size={12} />
              add your first app
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-2">
          {apps.map((app) => {
            const repo = repoFor.get(app.name);
            const exists = repo?.exists ?? false;
            const branch = repo?.branch ?? null;
            const stats = statsByApp.get(app.name) ?? ZERO_STATS;
            const scanning =
              scanApp.isPending && scanApp.variables === app.name;
            const settingsHighlight =
              !!app.git &&
              (app.git.branchMode !== "current" || app.git.autoCommit);
            const open = () => openTasksFor(app.name);

            return (
              <li key={app.name}>
                <div
                  role="link"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open();
                    }
                  }}
                  title={`view tasks for ${app.name}`}
                  className={cn(
                    "rounded-sm border bg-card p-3 transition-colors cursor-pointer",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    exists
                      ? "border-border hover:border-input hover:bg-accent/40"
                      : "border-status-doing/40 bg-status-doing/5 hover:bg-status-doing/10",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Folder
                      size={16}
                      className={cn(
                        "mt-0.5 shrink-0",
                        exists ? "text-primary" : "text-status-doing",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {app.name}
                        </span>
                        <span
                          className={cn(
                            "inline-block h-1.5 w-1.5 rounded-full",
                            exists ? "bg-status-done" : "bg-status-doing",
                          )}
                          title={exists ? "on disk" : "missing on disk"}
                        />
                        {!exists && (
                          <span className="rounded-full bg-status-doing/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wideish text-status-doing">
                            missing
                          </span>
                        )}
                        {branch && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            <GitBranch size={9} className="opacity-70" />
                            {branch}
                          </span>
                        )}
                      </div>
                      {app.description && (
                        <p className="mt-1 text-small text-foreground/85 whitespace-pre-line">
                          {app.description}
                        </p>
                      )}
                      <p
                        className="mt-1 break-all font-mono text-[11px] text-muted-foreground"
                        title={
                          app.rawPath && app.rawPath !== app.path
                            ? `${app.rawPath} → ${app.path}`
                            : app.path
                        }
                      >
                        {app.rawPath ?? app.path}
                        {app.rawPath && app.rawPath !== app.path && (
                          <> → {app.path}</>
                        )}
                      </p>

                      {/* Per-app counters: idle / doing / done / live. */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                        <CounterPill
                          label="doing"
                          value={stats.doing}
                          tone="doing"
                        />
                        <CounterPill
                          label="done"
                          value={stats.done}
                          tone="done"
                        />
                        <CounterPill
                          label="idle"
                          value={stats.idle}
                          tone="muted"
                        />
                        {stats.activeSessions > 0 && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-status-doing/15 px-1.5 py-0.5 text-status-doing"
                            title="sessions currently running for this app"
                          >
                            <span className="relative inline-flex h-1.5 w-1.5">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-doing opacity-60" />
                              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-doing" />
                            </span>
                            <span className="tabular-nums">
                              {stats.activeSessions}
                            </span>{" "}
                            live
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-1"
                      // Stop the row's open-tasks click from firing when
                      // the operator clicks an icon button.
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => setSettingsApp(app)}
                        title={
                          settingsHighlight
                            ? "git policy customised"
                            : "settings"
                        }
                        aria-label={`settings for ${app.name}`}
                        className={
                          settingsHighlight
                            ? "text-primary"
                            : "text-muted-foreground hover:text-primary"
                        }
                      >
                        <SettingsIcon size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => void onScan(app.name)}
                        disabled={!exists || scanning}
                        title={exists ? "re-scan" : "missing on disk"}
                        aria-label={`scan ${app.name}`}
                      >
                        <Sparkles
                          size={13}
                          className={
                            scanning ? "animate-pulse text-primary" : ""
                          }
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => void onDelete(app.name)}
                        title="remove from registry"
                        aria-label={`remove ${app.name}`}
                        className="text-muted-foreground hover:text-status-blocked"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AddAppDialog open={addOpen} onOpenChange={setAddOpen} />
      <AutoDetectDialog open={autoOpen} onOpenChange={setAutoOpen} />
      <AppSettingsDialog
        key={settingsApp?.name ?? "closed"}
        app={settingsApp}
        onClose={() => setSettingsApp(null)}
      />
    </div>
  );
}

function CounterPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "doing" | "done" | "muted";
}) {
  const cls =
    tone === "doing"
      ? "bg-status-doing/15 text-status-doing"
      : tone === "done"
        ? "bg-status-done/15 text-status-done"
        : "bg-muted/40 text-muted-foreground";
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5", cls)}
      title={`tasks: ${label}`}
    >
      <span className="tabular-nums">{value}</span> {label}
    </span>
  );
}
