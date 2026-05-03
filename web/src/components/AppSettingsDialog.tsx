// Reshaped to match main's tighter, single-scroll form: a `<fieldset>`
// per concern (branch strategy / toggles / integration / retry budgets)
// instead of the seven-tab spread we used to ship. Drops verify /
// quality / extras (SPA-only additions main doesn't carry) — those land
// when their own panels return.

import { useMemo, useState } from "react";
import { Settings } from "lucide-react";
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
import { useToast } from "@/components/Toasts";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  App,
  AppGitSettings,
  AppRetry,
  GitBranchMode,
  GitIntegrationMode,
} from "@/api/types";

interface Props {
  app: App | null;
  onClose: () => void;
}

// Mirrors the bridge.json APP_NAME_RE so the UI rejects bad names
// before the round-trip. Same regex Go uses server-side.
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MODE_OPTIONS: Array<{
  value: GitBranchMode;
  label: string;
  hint: string;
}> = [
  {
    value: "current",
    label: "Use the currently-checked-out branch",
    hint: "Default. Claude works on whatever branch HEAD points at when the agent starts.",
  },
  {
    value: "fixed",
    label: "Always work on a fixed branch",
    hint: "Bridge runs `git checkout <branch>` (or creates it from the current branch) before each task.",
  },
  {
    value: "auto-create",
    label: "Auto-create a new branch per task",
    hint: "Bridge creates `claude/<task-id>` from the current branch — keeps each task isolated.",
  },
];

const INTEGRATION_OPTIONS: Array<{
  value: GitIntegrationMode;
  label: string;
  hint: string;
}> = [
  {
    value: "none",
    label: "None — leave the work branch alone",
    hint: "Default. Operator merges or opens a PR by hand.",
  },
  {
    value: "auto-merge",
    label: "Auto-merge into a target branch (local git)",
    hint: "Bridge runs `git merge --no-ff` after the work branch commits. Conflict aborts cleanly; work branch preserved.",
  },
  {
    value: "pull-request",
    label: "Open a PR/MR via gh / glab (devops agent)",
    hint: "Bridge spawns a devops agent that uses the matching CLI. Requires git remote + `gh` or `glab` installed.",
  },
];

const MAX_RETRY_PER_GATE = 5;

const RETRY_GATES: Array<{
  key: keyof AppRetry;
  label: string;
  hint: string;
}> = [
  {
    key: "crash",
    label: "Crash retry",
    hint: "Child agent exited non-zero. Re-runs with the failure transcript injected.",
  },
  {
    key: "verify",
    label: "Verify-chain retry",
    hint: "format/lint/typecheck/test/build failed. Re-runs with the failing step's output.",
  },
  {
    key: "claim",
    label: "Claim-vs-diff retry",
    hint: "Report's `## Changed files` didn't match the actual diff. Re-runs to fix the discrepancy.",
  },
  {
    key: "preflight",
    label: "Preflight retry",
    hint: "Agent edited code without enough Read calls first. Re-runs with a process directive.",
  },
  {
    key: "style",
    label: "Style-critic retry",
    hint: "LLM critic flagged the diff as alien to the codebase. Re-runs with critic findings.",
  },
  {
    key: "semantic",
    label: "Semantic-verifier retry",
    hint: "LLM verifier judged the diff doesn't accomplish the task. Re-runs with concerns.",
  },
];

/**
 * Strategy ladder for attempt N (purely informational — the prompt
 * shape is decided server-side by `retryLadder.strategyForAttempt`).
 */
const STRATEGY_AT_ATTEMPT: Record<number, string> = {
  1: "same-context (full prompt + failure)",
  2: "fresh-focus (drop chatter, focus narrowly)",
  3: "fixer-only (one-line directive)",
};

function defaultGit(): AppGitSettings {
  return {
    branchMode: "current",
    fixedBranch: "",
    autoCommit: false,
    autoPush: false,
    worktreeMode: "disabled",
    mergeTargetBranch: "",
    integrationMode: "none",
  };
}

export function AppSettingsDialog({ app, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();

  // ---- draft state ------------------------------------------------------
  const [name, setName] = useState<string>(app?.name ?? "");
  const [description, setDescription] = useState<string>(
    app?.description ?? "",
  );
  const [git, setGit] = useState<AppGitSettings>(() =>
    app?.git ? { ...defaultGit(), ...app.git } : defaultGit(),
  );
  const [retry, setRetry] = useState<AppRetry>(() => app?.retry ?? {});
  const [submitting, setSubmitting] = useState(false);

  // The Go bridge doesn't expose PATCH /api/apps/{name}; the only
  // documented mutations are POST /api/apps (add) and DELETE. We
  // round-trip the full record via remove + add to simulate an update.
  const update = useMutation({
    mutationFn: async (patch: Partial<App>): Promise<App> => {
      if (!app) throw new Error("no app loaded");
      const merged: App = { ...app, ...patch };
      await api.apps.remove(app.name);
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

  // ---- dirty tracking ---------------------------------------------------
  const dirty = useMemo(() => {
    if (!app) return false;
    if (name.trim() !== app.name) return true;
    if ((description ?? "").trim() !== (app.description ?? "")) return true;
    const orig = app.git ?? defaultGit();
    if (git.branchMode !== (orig.branchMode ?? "current")) return true;
    if ((git.fixedBranch ?? "").trim() !== (orig.fixedBranch ?? "")) return true;
    if ((git.autoCommit ?? false) !== (orig.autoCommit ?? false)) return true;
    if ((git.autoPush ?? false) !== (orig.autoPush ?? false)) return true;
    if (
      (git.mergeTargetBranch ?? "").trim() !== (orig.mergeTargetBranch ?? "")
    )
      return true;
    if ((git.integrationMode ?? "none") !== (orig.integrationMode ?? "none"))
      return true;
    const origRetry = app.retry ?? {};
    const keys = new Set<keyof AppRetry>([
      ...(Object.keys(origRetry) as (keyof AppRetry)[]),
      ...(Object.keys(retry) as (keyof AppRetry)[]),
    ]);
    for (const k of keys) {
      if ((origRetry[k] ?? null) !== (retry[k] ?? null)) return true;
    }
    return false;
  }, [app, name, description, git, retry]);

  if (!app) return null;

  // Switching integration mode promotes the matching git settings so
  // the mode is internally consistent the moment it lands.
  const onIntegrationModeChange = (mode: GitIntegrationMode) => {
    setGit((g) => {
      if (mode === "none") {
        return { ...g, integrationMode: "none", mergeTargetBranch: "" };
      }
      if (mode === "pull-request") {
        return {
          ...g,
          integrationMode: "pull-request",
          autoCommit: true,
          autoPush: true,
        };
      }
      return { ...g, integrationMode: "auto-merge", autoCommit: true };
    });
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!APP_NAME_RE.test(trimmedName)) {
      toast.error(
        "invalid name",
        "letters, digits, dot, dash, underscore; must start alphanumeric",
      );
      return;
    }
    if (git.branchMode === "fixed" && !git.fixedBranch.trim()) {
      toast.error("validation", "fixed-branch mode needs a branch name");
      return;
    }
    const targetBranch = (git.mergeTargetBranch ?? "").trim();
    if ((git.integrationMode ?? "none") !== "none" && !targetBranch) {
      toast.error(
        "validation",
        "integration needs a target branch (or set mode to None)",
      );
      return;
    }
    setSubmitting(true);
    try {
      await update.mutateAsync({
        name: trimmedName,
        description: description.trim(),
        git,
        retry,
      });
      toast.success(`saved ${trimmedName}`);
      onClose();
    } catch (e) {
      toast.error("save failed", (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings size={16} />
            <span>
              Edit app — <span className="font-mono">{app.name}</span>
            </span>
          </DialogTitle>
          <DialogDescription>
            Update the app&apos;s identity and how the bridge prepares git for
            tasks targeting it.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-4"
        >
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input
                id="app-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={app.name}
                className="font-mono h-8"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">
                Used by the coordinator to dispatch tasks to this folder.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-description">Description</Label>
              <Textarea
                id="app-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="One or two lines about what this app does — fed to the dispatch heuristic."
                className="text-xs"
              />
            </div>
          </div>

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Branch strategy
            </legend>
            {MODE_OPTIONS.map((opt) => {
              const checked = git.branchMode === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`flex gap-2 rounded-md border p-2 cursor-pointer transition-colors ${
                    checked
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-accent/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="branchMode"
                    value={opt.value}
                    checked={checked}
                    onChange={() =>
                      setGit((g) => ({ ...g, branchMode: opt.value }))
                    }
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {opt.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {git.branchMode === "fixed" && (
            <div className="grid gap-1.5">
              <Label htmlFor="fixed-branch">Branch name</Label>
              <Input
                id="fixed-branch"
                value={git.fixedBranch}
                onChange={(e) =>
                  setGit((g) => ({ ...g, fixedBranch: e.target.value }))
                }
                placeholder="develop"
                className="font-mono h-8"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Bridge will check out this branch (creating it from the
                current HEAD if missing) before each task.
              </p>
            </div>
          )}

          <div className="grid gap-2 border-t border-border pt-3">
            <ToggleRow
              label="Auto-commit when the task finishes"
              hint="Runs `git add -A && git commit` with the task title as the message after a successful run."
              checked={git.autoCommit}
              onChange={(v) =>
                setGit((g) => ({
                  ...g,
                  autoCommit: v,
                  // Disabling auto-commit cascades: no push, no integration.
                  autoPush: v ? g.autoPush : false,
                  integrationMode: v ? g.integrationMode : "none",
                  mergeTargetBranch: v ? g.mergeTargetBranch : "",
                }))
              }
            />
            <ToggleRow
              label="Auto-push after auto-commit"
              hint="Runs `git push` to the tracked upstream. Implies auto-commit."
              checked={git.autoPush}
              disabled={
                !git.autoCommit || git.integrationMode === "pull-request"
              }
              onChange={(v) =>
                setGit((g) => ({
                  ...g,
                  autoPush: v,
                  autoCommit: v || g.autoCommit,
                }))
              }
            />
          </div>

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Post-success integration
            </legend>
            {INTEGRATION_OPTIONS.map((opt) => {
              const checked = (git.integrationMode ?? "none") === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`flex gap-2 rounded-md border p-2 cursor-pointer transition-colors ${
                    checked
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-accent/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="integrationMode"
                    value={opt.value}
                    checked={checked}
                    onChange={() => onIntegrationModeChange(opt.value)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {opt.hint}
                    </span>
                  </span>
                </label>
              );
            })}
            {(git.integrationMode ?? "none") !== "none" && (
              <div className="grid gap-1.5 mt-1">
                <Label htmlFor="merge-target" className="text-xs font-medium">
                  Target branch
                </Label>
                <Input
                  id="merge-target"
                  value={git.mergeTargetBranch ?? ""}
                  onChange={(e) =>
                    setGit((g) => ({
                      ...g,
                      mergeTargetBranch: e.target.value,
                    }))
                  }
                  placeholder="main"
                  className="font-mono h-8"
                />
                <p className="text-[11px] text-muted-foreground">
                  {git.integrationMode === "auto-merge"
                    ? "Bridge runs git checkout <target> + git merge --no-ff. Conflict aborts cleanly; work branch preserved."
                    : "Bridge spawns the devops agent which uses gh / glab to open a PR/MR. Requires git remote + the matching CLI installed."}
                </p>
              </div>
            )}
          </fieldset>

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Retry budgets
            </legend>
            <p className="text-[11px] text-muted-foreground -mt-1 mb-1">
              Per-gate attempt cap. Default 1 = single retry. Higher budgets
              unlock the strategy ladder: attempt 2 = focused re-prompt,
              attempt 3+ = fixer-only directive.
            </p>
            {RETRY_GATES.map((gate) => {
              const value = retry[gate.key] ?? 1;
              return (
                <div
                  key={gate.key}
                  className="grid gap-1 rounded-md border border-border p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{gate.label}</span>
                    <select
                      value={String(value)}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setRetry((r) => ({ ...r, [gate.key]: n }));
                      }}
                      className="h-7 rounded border border-input bg-background px-2 text-xs font-mono"
                    >
                      {Array.from(
                        { length: MAX_RETRY_PER_GATE + 1 },
                        (_, i) => (
                          <option key={i} value={i}>
                            {i === 0
                              ? "0 (off)"
                              : i === MAX_RETRY_PER_GATE
                                ? `${i} attempts (max)`
                                : `${i} attempt${i === 1 ? "" : "s"}`}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {gate.hint}
                  </span>
                  {value >= 2 && (
                    <span className="text-[10px] text-muted-foreground/80 font-mono">
                      strategy: 1→{STRATEGY_AT_ATTEMPT[1]}; 2→
                      {STRATEGY_AT_ATTEMPT[2]}
                      {value >= 3 ? `; ≥3→${STRATEGY_AT_ATTEMPT[3]}` : ""}
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !dirty}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
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
      className={`flex items-start gap-2 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
