import { useMemo, useState } from "react";
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
} from "@/api/queries";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import { AddAppDialog } from "@/components/AddAppDialog";
import { AppSettingsDialog } from "@/components/AppSettingsDialog";
import { AutoDetectDialog } from "@/components/AutoDetectDialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { App } from "@/api/types";
import { cn } from "@/lib/cn";

export default function AppsPage() {
  const { data: appsData, isLoading } = useApps();
  const { data: reposData } = useRepos();
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

  const onScan = async (name: string) => {
    try {
      const r = await scanApp.mutateAsync(name);
      toast.success(
        `scanned ${name}`,
        r.symbolCount != null ? `${r.symbolCount} symbols` : undefined,
      );
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

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Boxes size={18} className="text-accent" />
            <h1 className="font-mono text-display font-semibold tracking-tightish text-fg">
              apps
            </h1>
            <span className="font-mono text-micro uppercase tracking-wideish text-muted">
              {apps.length} app{apps.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-2 max-w-xl text-small text-muted">
            registered in{" "}
            <span className="font-mono text-fg">~/.claude/bridge.json</span>.
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
            return (
              <li
                key={app.name}
                className={cn(
                  "rounded-sm border bg-surface p-3 transition-colors",
                  exists
                    ? "border-border hover:border-border-strong"
                    : "border-status-doing/40 bg-status-doing/5",
                )}
              >
                <div className="flex items-start gap-3">
                  <Folder
                    size={16}
                    className={cn(
                      "mt-0.5 shrink-0",
                      exists ? "text-accent" : "text-status-doing",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-fg">
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
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          <GitBranch size={9} className="opacity-70" />
                          {branch}
                        </span>
                      )}
                    </div>
                    {app.description && (
                      <p className="mt-1 text-small text-fg/85 whitespace-pre-line">
                        {app.description}
                      </p>
                    )}
                    <p
                      className="mt-1 break-all font-mono text-[11px] text-muted"
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
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => setSettingsApp(app)}
                      title="settings"
                      aria-label={`settings for ${app.name}`}
                    >
                      <SettingsIcon size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => void onScan(app.name)}
                      disabled={!exists || scanApp.isPending}
                      title={exists ? "re-scan" : "missing on disk"}
                      aria-label={`scan ${app.name}`}
                    >
                      <Sparkles
                        size={13}
                        className={
                          scanApp.isPending && scanApp.variables === app.name
                            ? "animate-pulse text-accent"
                            : ""
                        }
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => void onDelete(app.name)}
                      title="remove from registry"
                      aria-label={`remove ${app.name}`}
                      className="text-muted hover:text-status-blocked"
                    >
                      <Trash2 size={13} />
                    </Button>
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
