"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, Folder, GitBranch, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import type { App } from "@/lib/client/types";
import { HeaderShell } from "../_components/HeaderShell";
import { AddAppDialog } from "../_components/AddAppDialog";
import { Button } from "../_components/ui/button";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";

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
  const [apps, setApps] = useState<App[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => { refresh(); }, [refresh]);

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
      <HeaderShell active="apps">
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden lg:inline text-[10px] text-muted-foreground">
            {apps.length} app{apps.length === 1 ? "" : "s"} registered
          </span>
          <AddAppDialog onChanged={refresh} openRef={addDialogRef} />
        </div>
      </HeaderShell>

      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-4">
            <Boxes size={18} className="text-primary" />
            <h2 className="text-lg font-semibold">Registered apps</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-6">
            Apps live in <code className="font-mono text-foreground">sessions/init.md</code>.
            The coordinator dispatches agents into these folders by name.
            Use <strong>Add app</strong> to register a folder by hand or <strong>Auto-detect</strong> to scan siblings of the bridge for code repos.
          </p>

          {loading ? (
            <p className="text-sm text-muted-foreground italic">Loading…</p>
          ) : apps.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center bg-card">
              <Boxes size={28} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium mb-1">No apps registered yet</p>
              <p className="text-xs text-muted-foreground mb-4">
                Click <strong>Add app</strong> in the header, or <strong>Auto-detect</strong> to scan the parent directory.
              </p>
              <Button onClick={() => addDialogRef.current?.()} size="sm">
                Add your first app
              </Button>
            </div>
          ) : (
            <div className="grid gap-2">
              {apps.map((app) => {
                const meta = repoMeta(app.name);
                const exists = meta?.exists ?? false;
                const branch = meta?.branch ?? null;
                return (
                  <div
                    key={app.name}
                    className={`rounded-lg border p-3 bg-card transition-colors ${
                      exists
                        ? "border-border hover:border-primary/40"
                        : "border-warning/40 bg-warning/5"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Folder
                        size={18}
                        className={`mt-0.5 shrink-0 ${exists ? "text-primary" : "text-warning"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-semibold">{app.name}</span>
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
                          <p className="mt-1 text-xs text-foreground/80">{app.description}</p>
                        )}
                        <p className="mt-1 text-[11px] text-muted-foreground font-mono break-all">
                          {app.rawPath}
                          {app.rawPath !== app.path && ` → ${app.path}`}
                        </p>
                      </div>
                      <Button
                        onClick={() => handleDelete(app.name)}
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
    </div>
  );
}

export default function Page() {
  return <AppsPage />;
}
