import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Boxes,
  Folder,
  GitBranch,
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
import { AddAppDialog, type AddAppDialogHandle } from "@/components/AddAppDialog";
import { AppSettingsDialog } from "@/components/AppSettingsDialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ListSkeleton } from "@/components/ui/skeleton";
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
  const tasks = tasksQuery.data ?? [];

  const scanApp = useScanApp();
  const removeApp = useRemoveApp();
  const toast = useToast();
  const confirm = useConfirm();

  const [addOpen, setAddOpen] = useState(false);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const addDialogRef = useRef<AddAppDialogHandle>(null);

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
          `Scanned ${name}`,
          r.symbolCount != null
            ? `${r.symbolCount} symbols indexed`
            : undefined,
        );
      } else if (r.symbolCount != null) {
        toast.info(`Re-indexed ${name}`, `${r.symbolCount} symbols`);
      } else {
        toast.info(`Scan returned no changes for ${name}`);
      }
    } catch (e) {
      toast.error("Scan failed", (e as Error).message);
    }
  };

  const onDelete = async (name: string) => {
    const ok = await confirm({
      title: `Remove ${name}?`,
      description:
        "This only removes the entry from the apps registry. The folder on disk is untouched.",
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await removeApp.mutateAsync(name);
      toast.info(`Removed ${name}`);
    } catch (e) {
      toast.error("Delete failed", (e as Error).message);
    }
  };

  const openTasksFor = (name: string) =>
    navigate(`/tasks?app=${encodeURIComponent(name)}`);

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Boxes size={18} className="text-primary" />
          <h2 className="text-base sm:text-lg font-semibold">Registered apps</h2>
          <span className="text-[10px] text-muted-foreground">
            {apps.length} app{apps.length === 1 ? "" : "s"}
          </span>
        </div>
        <AddAppDialog
          ref={addDialogRef}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      </div>
      <p className="mb-6 text-[11px] sm:text-xs text-muted-foreground">
        Apps live in <code className="font-mono text-foreground">~/.claude/bridge.json</code>
        {" "}(outside this project, so version updates can&apos;t overwrite it).
        The coordinator dispatches agents into these folders by name.
        Use <strong>Add app</strong> to register a folder by hand or <strong>Auto-detect</strong> to scan siblings of the bridge for code repos.
      </p>

      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : apps.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No apps registered yet"
          hint="Click Add app in the header, or Auto-detect to scan the parent directory."
          action={
            <Button onClick={() => addDialogRef.current?.open()} size="sm">
              Add your first app
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
                  title={`View tasks for ${app.name}`}
                  className={cn(
                    "rounded-lg border bg-card p-3 transition-colors cursor-pointer",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    exists
                      ? "border-border hover:border-primary/40 hover:bg-accent/40"
                      : "border-warning/40 bg-warning/5 hover:bg-warning/10",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Folder
                      size={18}
                      className={cn(
                        "mt-0.5 shrink-0",
                        exists ? "text-primary" : "text-warning",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] sm:text-sm font-semibold">
                          {app.name}
                        </span>
                        {!exists && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-warning/20 text-warning text-[9px] font-medium uppercase tracking-wide">
                            missing
                          </span>
                        )}
                        {branch && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-secondary border border-border text-[10px] text-fg-dim font-mono"
                            title={`branch: ${branch}`}
                          >
                            <GitBranch size={9} className="opacity-70" />
                            {branch}
                          </span>
                        )}
                      </div>
                      {app.description && (
                        <p className="mt-1 text-[11px] sm:text-xs text-foreground/80 line-clamp-3 sm:line-clamp-none whitespace-pre-line">
                          {app.description}
                        </p>
                      )}
                      <p
                        className="mt-1 text-[10.5px] sm:text-[11px] text-muted-foreground font-mono break-all line-clamp-2 sm:line-clamp-none"
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
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[10px] font-medium">
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-warning/15 text-warning"
                          title="Tasks in DOING"
                        >
                          <span className="tabular-nums">{stats.doing}</span> doing
                        </span>
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-success/15 text-success"
                          title="Tasks in DONE — not yet archived"
                        >
                          <span className="tabular-nums">{stats.done}</span> done
                        </span>
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-fg-dim/15 text-fg-dim"
                          title="Tasks in TODO"
                        >
                          <span className="tabular-nums">{stats.idle}</span> idle
                        </span>
                        {stats.activeSessions > 0 && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-warning/15 text-warning"
                            title="Sessions currently running for this app"
                          >
                            <span className="relative inline-flex h-1.5 w-1.5">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
                              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-warning" />
                            </span>
                            <span className="tabular-nums">
                              {stats.activeSessions}
                            </span>{" "}
                            active
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
                        onClick={() => void onScan(app.name)}
                        disabled={!exists || scanning}
                        title={exists ? "Re-scan" : "Missing on disk"}
                        aria-label={`Scan ${app.name}`}
                      >
                        <Sparkles
                          size={14}
                          className={
                            scanning ? "animate-pulse text-primary" : ""
                          }
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => setSettingsApp(app)}
                        title={
                          settingsHighlight
                            ? "Git policy customised"
                            : "Settings"
                        }
                        aria-label={`Settings for ${app.name}`}
                        className={
                          settingsHighlight
                            ? "text-primary"
                            : "text-fg-dim hover:text-primary"
                        }
                      >
                        <SettingsIcon size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => void onDelete(app.name)}
                        title="Remove from registry"
                        aria-label={`Remove ${app.name}`}
                        className="text-fg-dim hover:text-destructive"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AppSettingsDialog
        key={settingsApp?.name ?? "closed"}
        app={settingsApp}
        onClose={() => setSettingsApp(null)}
      />
    </div>
  );
}
