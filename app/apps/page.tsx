"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Folder, GitBranch, Settings, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/libs/client/api";
import type { App, Meta, Task } from "@/libs/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { AddAppDialog } from "../_components/AddAppDialog";
import { AppSettingsDialog } from "../_components/AppSettingsDialog";
import { Button } from "../_components/ui/button";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";
import { ListSkeleton } from "../_components/ui/skeleton";
import { EmptyState } from "../_components/ui/empty-state";

interface RepoEntry {
  name: string;
  path: string;
  exists: boolean;
  branch?: string | null;
}

/**
 * Apps registry page. Lists every app declared in `sessions/init.md`
 * with metadata (path, description, branch, on-disk presence) and
 * exposes Add / Auto-detect / Delete actions.
 */
function AppsPage() {
  const router = useRouter();
  const [apps, setApps] = useState<App[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [metaByTask, setMetaByTask] = useState<Map<string, Meta>>(new Map());
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState<Set<string>>(new Set());
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const addDialogRef = useRef<(() => void) | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.apps(), api.repos()]);
      setApps(a);
      setRepos(r);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const refreshStats = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([api.tasks(), api.allMeta()]);
      setTasks(t);
      setMetaByTask(new Map(Object.entries(m)));
    } catch { /* stats are best-effort */ }
  }, []);

  // Mount-time fetch: scheduled as a microtask so the setState calls
  // inside `refresh` / `refreshStats` happen after the effect body
  // returns. Calling them synchronously here would trip
  // `react-hooks/set-state-in-effect`.
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  useEffect(() => {
    void Promise.resolve().then(refreshStats);
  }, [refreshStats]);

  // Refresh both lists immediately when the user comes back to the tab —
  // otherwise stats can be stale for up to 15s after a long absence.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        void refreshStats();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh, refreshStats]);

  // Live-ish stats: poll faster while any run is active, slower otherwise.
  const metaRef = useRef(metaByTask);
  useEffect(() => { metaRef.current = metaByTask; }, [metaByTask]);
  useEffect(() => {
    let h: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const anyRunning = Array.from(metaRef.current.values()).some((m) =>
        m.runs.some((r) => r.status === "running"),
      );
      void refreshStats();
      h = setTimeout(tick, anyRunning ? 4_000 : 15_000);
    };
    h = setTimeout(tick, 4_000);
    return () => { if (h) clearTimeout(h); };
  }, [refreshStats]);

  const statsByApp = useMemo(() => {
    const stats = new Map<string, { idle: number; doing: number; done: number; activeSessions: number }>();
    const ensure = (name: string) => {
      let s = stats.get(name);
      if (!s) {
        s = { idle: 0, doing: 0, done: 0, activeSessions: 0 };
        stats.set(name, s);
      }
      return s;
    };
    for (const t of tasks) {
      if (!t.app) continue;
      const s = ensure(t.app);
      if (t.section === "DONE — not yet archived") s.done += 1;
      else if (t.section === "DOING") s.doing += 1;
      else if (t.section === "TODO") s.idle += 1;
      // BLOCKED is intentionally left out of the three task buckets.
      const meta = metaByTask.get(t.id);
      if (meta) {
        for (const r of meta.runs) {
          if (r.status === "running") s.activeSessions += 1;
        }
      }
    }
    return stats;
  }, [tasks, metaByTask]);

  const handleScan = async (name: string) => {
    setScanning((s) => new Set(s).add(name));
    try {
      const r = await api.scanApp(name);
      if (r.scanned) {
        toast("success", `Claude updated description for ${name}`);
        await refresh();
      } else {
        toast("info", `No new description for ${name} (${r.reason ?? "scan-failed"})`);
      }
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setScanning((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  };

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: `Remove ${name}?`,
      description:
        "This only removes the entry from the apps registry. The folder on disk is untouched.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.removeApp(name);
      await refresh();
      toast("info", `Removed ${name}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const repoMeta = (name: string) => repos.find((r) => r.name === name) ?? null;

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="apps" />

      <main className="flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6 max-w-4xl mx-auto">
          <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Boxes size={18} className="text-primary" />
              <h2 className="text-base sm:text-lg font-semibold">Registered apps</h2>
              <span className="text-[10px] text-muted-foreground">
                {apps.length} app{apps.length === 1 ? "" : "s"}
              </span>
            </div>
            <AddAppDialog onChanged={refresh} openRef={addDialogRef} />
          </div>
          <p className="text-[11px] sm:text-xs text-muted-foreground mb-6">
            Apps live in <code className="font-mono text-foreground">~/.claude/bridge.json</code>
            (outside this project, so version updates can&apos;t overwrite it).
            The coordinator dispatches agents into these folders by name.
            Use <strong>Add app</strong> to register a folder by hand or <strong>Auto-detect</strong> to scan siblings of the bridge for code repos.
          </p>

          {loading ? (
            <ListSkeleton rows={4} />
          ) : apps.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No apps registered yet"
              hint="Click Add app in the header, or Auto-detect to scan the parent directory."
              action={
                <Button onClick={() => addDialogRef.current?.()} size="sm">
                  Add your first app
                </Button>
              }
            />
          ) : (
            <div className="grid gap-2">
              {apps.map((app) => {
                const meta = repoMeta(app.name);
                const exists = meta?.exists ?? false;
                const branch = meta?.branch ?? null;
                const stats = statsByApp.get(app.name) ?? { idle: 0, doing: 0, done: 0, activeSessions: 0 };
                const openDetail = () =>
                  router.push(`/apps/${encodeURIComponent(app.name)}`);
                return (
                  <div
                    key={app.name}
                    role="link"
                    tabIndex={0}
                    onClick={openDetail}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail();
                      }
                    }}
                    title={`Open ${app.name} — git, diff, terminal`}
                    className={`rounded-lg border p-3 bg-card transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                      exists
                        ? "border-border hover:border-primary/40 hover:bg-accent/40"
                        : "border-warning/40 bg-warning/5 hover:bg-warning/10"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Folder
                        size={18}
                        className={`mt-0.5 shrink-0 ${exists ? "text-primary" : "text-warning"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[13px] sm:text-sm font-semibold">{app.name}</span>
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
                          <p className="mt-1 text-[11px] sm:text-xs text-foreground/80 line-clamp-3 sm:line-clamp-none">
                            {app.description}
                          </p>
                        )}
                        <p
                          className="mt-1 text-[10.5px] sm:text-[11px] text-muted-foreground font-mono break-all line-clamp-2 sm:line-clamp-none"
                          title={app.rawPath !== app.path ? `${app.rawPath} → ${app.path}` : app.rawPath}
                        >
                          {app.rawPath}
                          {app.rawPath !== app.path && ` → ${app.path}`}
                        </p>
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
                              title="Sessions currently running for this app's tasks"
                            >
                              <span className="relative inline-flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
                              </span>
                              <span className="tabular-nums">{stats.activeSessions}</span> active
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        onClick={(e) => { e.stopPropagation(); handleScan(app.name); }}
                        disabled={scanning.has(app.name) || !exists}
                        variant="ghost"
                        size="iconSm"
                        title={exists ? "Re-scan with Claude to refresh the description" : "Folder is missing — cannot scan"}
                        aria-label={`Scan ${app.name} with Claude`}
                        className="text-fg-dim hover:text-primary shrink-0"
                      >
                        <Sparkles size={14} className={scanning.has(app.name) ? "animate-pulse text-primary" : ""} />
                      </Button>
                      <Button
                        onClick={(e) => { e.stopPropagation(); setSettingsApp(app); }}
                        variant="ghost"
                        size="iconSm"
                        title="Git workflow settings (branch, auto-commit, push)"
                        aria-label={`Settings for ${app.name}`}
                        className={`shrink-0 ${
                          app.git.branchMode !== "current" || app.git.autoCommit
                            ? "text-primary"
                            : "text-fg-dim hover:text-primary"
                        }`}
                      >
                        <Settings size={14} />
                      </Button>
                      <Button
                        onClick={(e) => { e.stopPropagation(); handleDelete(app.name); }}
                        variant="ghost"
                        size="iconSm"
                        title="Remove from registry (folder on disk is kept)"
                        aria-label={`Remove ${app.name}`}
                        className="text-fg-dim hover:text-destructive shrink-0"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      <AppSettingsDialog
        key={settingsApp?.name ?? "closed"}
        app={settingsApp}
        onClose={() => setSettingsApp(null)}
        onSaved={(updated) => {
          setApps((list) => list.map((a) => (a.name === updated.name ? updated : a)));
        }}
      />
    </div>
  );
}

export default function Page() {
  return <AppsPage />;
}
