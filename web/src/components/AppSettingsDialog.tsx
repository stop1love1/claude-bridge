import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/Toasts";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  App,
  AppGitSettings,
  AppRetry,
  AppVerify,
  GitBranchMode,
  GitWorktreeMode,
  AppExtras,
} from "@/api/types";

interface Props {
  app: App | null;
  onClose: () => void;
}

const BRANCH_MODES: { value: GitBranchMode; label: string }[] = [
  { value: "current", label: "current — use whatever HEAD is on" },
  { value: "fixed", label: "fixed — checkout a named branch" },
  { value: "auto-create", label: "auto-create — claude/<task-id>" },
];

const WORKTREE_MODES: { value: GitWorktreeMode; label: string }[] = [
  { value: "disabled", label: "disabled — operate in the main tree" },
  { value: "enabled", label: "enabled — isolated worktree per run" },
];

const RETRY_GATES: Array<{ key: keyof AppRetry; label: string; hint: string }> = [
  { key: "crash", label: "crash", hint: "child agent exited non-zero" },
  { key: "verify", label: "verify", hint: "format/lint/typecheck/test/build" },
  { key: "claim", label: "claim", hint: "claim-vs-diff mismatch" },
  { key: "preflight", label: "preflight", hint: "preflight gate failure" },
  { key: "style", label: "style", hint: "style-critic gate" },
  { key: "semantic", label: "semantic", hint: "semantic verifier" },
];

const MAX_RETRY_PER_GATE = 5;

/**
 * Tabbed editor — Git / Retry / Verify / Extras. Pass `app=null` to
 * close. Use `key={app?.name ?? "closed"}` on the parent so the local
 * draft resets when the target app changes.
 */
export function AppSettingsDialog({ app, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const [git, setGit] = useState<AppGitSettings>(() =>
    app?.git
      ? { ...app.git }
      : {
          branchMode: "current",
          fixedBranch: "",
          autoCommit: false,
          autoPush: false,
          worktreeMode: "disabled",
        },
  );
  const [retry, setRetry] = useState<AppRetry>(() => app?.retry ?? {});
  const [verify, setVerify] = useState<AppVerify>(() => app?.verify ?? {});
  const [extrasText, setExtrasText] = useState<string>(() =>
    app?.extras ? JSON.stringify(app.extras, null, 2) : "{}",
  );
  const [extrasError, setExtrasError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: async (patch: Partial<App>): Promise<App> => {
      // The Go bridge doesn't expose PATCH /api/apps/{name}; the only
      // documented mutations on the registry are POST /api/apps (add)
      // and DELETE. We round-trip the full record via remove + add to
      // simulate an update for the existing endpoints.
      if (!app) throw new Error("no app loaded");
      await api.apps.remove(app.name);
      const merged: App = { ...app, ...patch };
      await api.apps.add({
        name: merged.name,
        path: merged.path,
        description: merged.description,
      });
      return merged;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.apps });
    },
  });

  const extrasParsed = useMemo<AppExtras | null>(() => {
    try {
      const parsed = JSON.parse(extrasText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AppExtras;
      }
      return null;
    } catch {
      return null;
    }
  }, [extrasText]);

  if (!app) return null;

  const submit = async () => {
    if (git.branchMode === "fixed" && !git.fixedBranch.trim()) {
      toast.error("validation", "fixed-branch mode needs a branch name");
      return;
    }
    if (extrasText.trim().length > 0) {
      try {
        const parsed = JSON.parse(extrasText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setExtrasError("extras must be a JSON object");
          return;
        }
      } catch (e) {
        setExtrasError(`invalid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setExtrasError(null);
    try {
      await update.mutateAsync({
        git,
        retry,
        verify,
        extras: extrasParsed ?? {},
      });
      toast.success(`saved ${app.name}`);
      onClose();
    } catch (e) {
      toast.error("save failed", (e as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            edit <span className="font-mono text-foreground">{app.name}</span>
          </DialogTitle>
          <DialogDescription>
            git workflow, retry budgets, verify commands, and extras for the
            bridge to honor when running tasks here.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="git" className="w-full">
          <TabsList>
            <TabsTrigger value="git">git</TabsTrigger>
            <TabsTrigger value="retry">retry</TabsTrigger>
            <TabsTrigger value="verify">verify</TabsTrigger>
            <TabsTrigger value="extras">extras</TabsTrigger>
          </TabsList>

          {/* ─── Git ─── */}
          <TabsContent value="git" className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="branch-mode">branch mode</Label>
              <Select
                value={git.branchMode}
                onValueChange={(v) =>
                  setGit({ ...git, branchMode: v as GitBranchMode })
                }
              >
                <SelectTrigger id="branch-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BRANCH_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {git.branchMode === "fixed" && (
              <div className="grid gap-1.5">
                <Label htmlFor="fixed-branch">fixed branch</Label>
                <Input
                  id="fixed-branch"
                  value={git.fixedBranch}
                  onChange={(e) =>
                    setGit({ ...git, fixedBranch: e.target.value })
                  }
                  placeholder="develop"
                />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="worktree-mode">worktree mode</Label>
              <Select
                value={git.worktreeMode ?? "disabled"}
                onValueChange={(v) =>
                  setGit({ ...git, worktreeMode: v as GitWorktreeMode })
                }
              >
                <SelectTrigger id="worktree-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKTREE_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <SwitchRow
              label="auto-commit"
              hint="run `git add -A && git commit` after a successful run"
              checked={git.autoCommit}
              onChange={(v) =>
                setGit({
                  ...git,
                  autoCommit: v,
                  autoPush: v ? git.autoPush : false,
                })
              }
            />
            <SwitchRow
              label="auto-push"
              hint="run `git push` after auto-commit (requires auto-commit)"
              checked={git.autoPush}
              disabled={!git.autoCommit}
              onChange={(v) => setGit({ ...git, autoPush: v })}
            />
          </TabsContent>

          {/* ─── Retry ─── */}
          <TabsContent value="retry" className="grid gap-2">
            <p className="text-[11px] text-muted-foreground -mt-1">
              per-gate attempt cap. unset = bridge default (1). higher budgets
              unlock the strategy ladder.
            </p>
            {RETRY_GATES.map((gate) => {
              const value = retry[gate.key] ?? 1;
              return (
                <div
                  key={gate.key}
                  className="flex items-center justify-between gap-3 rounded-sm border border-border p-2"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-micro uppercase tracking-wideish text-foreground">
                      {gate.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{gate.hint}</div>
                  </div>
                  <select
                    value={String(value)}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setRetry({ ...retry, [gate.key]: n });
                    }}
                    className="h-7 rounded-sm border border-border bg-background px-2 font-mono text-xs"
                  >
                    {Array.from({ length: MAX_RETRY_PER_GATE + 1 }, (_, i) => (
                      <option key={i} value={i}>
                        {i === 0 ? "0 (off)" : `${i}`}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </TabsContent>

          {/* ─── Verify ─── */}
          <TabsContent value="verify" className="grid gap-3">
            <p className="text-[11px] text-muted-foreground -mt-1">
              shell commands the verify-chain runs after each successful
              child. leave blank to skip a step.
            </p>
            {(["format", "lint", "typecheck", "test", "build"] as const).map(
              (key) => (
                <div key={key} className="grid gap-1.5">
                  <Label htmlFor={`verify-${key}`}>{key}</Label>
                  <Input
                    id={`verify-${key}`}
                    value={verify[key] ?? ""}
                    onChange={(e) =>
                      setVerify({ ...verify, [key]: e.target.value })
                    }
                    placeholder={defaultPlaceholder(key)}
                    spellCheck={false}
                  />
                </div>
              ),
            )}
          </TabsContent>

          {/* ─── Extras ─── */}
          <TabsContent value="extras" className="grid gap-2">
            <p className="text-[11px] text-muted-foreground">
              freeform JSON object. the bridge round-trips this verbatim;
              consumers like the coordinator prompt may read it.
            </p>
            <Textarea
              value={extrasText}
              onChange={(e) => {
                setExtrasText(e.target.value);
                setExtrasError(null);
              }}
              rows={10}
              spellCheck={false}
              className="font-mono"
            />
            {extrasError && (
              <p className="font-mono text-micro text-status-blocked">
                {extrasError}
              </p>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={update.isPending}
          >
            {update.isPending ? "saving…" : "save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultPlaceholder(key: keyof AppVerify): string {
  switch (key) {
    case "format":
      return "pnpm fmt";
    case "lint":
      return "pnpm lint";
    case "typecheck":
      return "pnpm tsc --noEmit";
    case "test":
      return "pnpm test";
    case "build":
      return "pnpm build";
    default:
      return "";
  }
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-sm border border-border p-2 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span className="flex-1 min-w-0">
        <span className="block font-mono text-micro uppercase tracking-wideish text-foreground">
          {label}
        </span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
